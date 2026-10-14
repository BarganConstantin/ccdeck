// A bounded, one-shot read of Codex rollouts already on disk. The live watcher
// deliberately parks at EOF on boot; this reader supplies only roots whose
// latest recorded turn is still open and the relationships among those roots.
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { canonicalCwd } from "./canonical-path.mjs";
import { CODEX_SESSIONS_DIR, sidFromRolloutName, STOP, walkRolloutDays } from "./codex-dir.mjs";
import { codexCwdInWorkspace } from "./log-election.mjs";
import { codexSubagentActivity, sessionMeta } from "./codex-translate.mjs";
import { pushEvent } from "./event-sink.mjs";

const CHUNK_BYTES = 64 * 1024;
const MAX_RELEVANT_LINE = 1024 * 1024;
const MAX_HEADER_BYTES = 4 * 1024 * 1024;
let enabled = false;
let desired = true;
let configured = false;
let workspace = "";
let generation = 0;
let scanPromise = null;
let startupBoundaries = null;
let boundaryPromise = Promise.resolve(null);
let resolveBoundary = null;
const emitted = new Set();
const liveTurnRevision = new Map();
const MAX_LIVE_REVISIONS = 1024;

const nonEmpty = value => typeof value === "string" && value.length > 0 ? value : null;

function userInput(obj) {
  if (obj?.type !== "event_msg") return null;
  const payload = obj.payload ?? {};
  if (payload.type === "user_message" && typeof payload.message === "string") return payload.message;
  if (payload.type === "item_completed" && payload.item?.type === "UserMessage") {
    const parts = Array.isArray(payload.item.content) ? payload.item.content : [];
    return parts.map(part => typeof part?.text === "string" ? part.text : "").join("");
  }
  return null;
}

async function readHeader(path) {
  try {
    const size = (await stat(path)).size;
    const fh = await open(path, "r");
    try {
      let bytes = Buffer.alloc(0);
      for (let offset = 0; offset < Math.min(size, MAX_HEADER_BYTES);) {
        const want = Math.min(CHUNK_BYTES, size - offset, MAX_HEADER_BYTES - offset);
        if (want <= 0) break;
        const part = Buffer.alloc(want);
        const { bytesRead } = await fh.read(part, 0, want, offset);
        if (!bytesRead) break;
        bytes = Buffer.concat([bytes, part.subarray(0, bytesRead)]);
        offset += bytesRead;
        const nl = bytes.indexOf(0x0a);
        if (nl >= 0) {
          const obj = JSON.parse(bytes.subarray(0, nl).toString("utf8"));
          const meta = sessionMeta(obj);
          const sid = nonEmpty(meta?.id) ?? sidFromRolloutName(path);
          if (!meta || !sid) return null;
          return {
            sid,
            cwd: await canonicalCwd(meta.cwd),
            timestamp: typeof obj.timestamp === "string" ? obj.timestamp : undefined,
            model: nonEmpty(meta.model) ?? undefined,
            parentId: (() => {
              const direct = nonEmpty(meta.parent_thread_id);
              const nested = nonEmpty(meta.source?.subagent?.thread_spawn?.parent_thread_id);
              return direct && nested && direct !== nested ? null : direct || nested;
            })(),
            agent_type: nonEmpty(meta.agent_type) ?? undefined,
            agent_nickname: nonEmpty(meta.agent_nickname) ?? undefined,
            agent_role: nonEmpty(meta.agent_role) ?? undefined,
          };
        }
      }
    } finally { await fh.close(); }
  } catch { /* incomplete or unreadable rollout; retry on a later toggle */ }
  return null;
}

// Capture the last whole JSONL record. If a writer stopped midway through a
// record at startup, scan only the complete prefix and let the live tail read
// that entire partial record from its beginning once the newline arrives.
async function completeLineBoundary(path, size) {
  if (!size) return { boundary: 0, incomplete: false, fileSize: 0 };
  const fh = await open(path, "r");
  try {
    const last = Buffer.alloc(1);
    await fh.read(last, 0, 1, size - 1);
    if (last[0] === 0x0a) return { boundary: size, incomplete: false, fileSize: size };
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - CHUNK_BYTES);
      const part = Buffer.alloc(end - start);
      const { bytesRead } = await fh.read(part, 0, part.length, start);
      const nl = part.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (nl >= 0) return { boundary: start + nl + 1, incomplete: true, fileSize: size };
      end = start;
    }
    return { boundary: 0, incomplete: true, fileSize: size };
  } finally { await fh.close(); }
}

function fileIdentity(stats) {
  return { dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs };
}

function sameFileIdentity(a, b) {
  if (!a || !b || a.dev !== b.dev) return false;
  if (a.ino && b.ino) return a.ino === b.ino;
  return a.birthtimeMs > 0 && a.birthtimeMs === b.birthtimeMs;
}

// Yield complete, small JSONL records while keeping read buffers and partial
// lines bounded. Large tool-output lines are discarded: only lifecycle,
// header and spawn metadata can affect this snapshot.
async function scanRecords(path, onRecord, token, limit) {
  const fh = await open(path, "r");
  let offset = 0;
  let pending = "";
  let dropping = false;
  const decoder = new StringDecoder("utf8");
  let malformedCompleteLine = false;
  try {
    const size = Math.min(limit, (await fh.stat()).size);
    while (offset < size && token === generation && enabled) {
      const want = Math.min(CHUNK_BYTES, size - offset);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      const text = decoder.write(buf);
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) !== 10) continue;
        if (!dropping) {
          const line = pending + text.slice(start, i);
          if (line.length <= MAX_RELEVANT_LINE && line) {
            try { onRecord(JSON.parse(line)); } catch { malformedCompleteLine = true; }
          }
        }
        pending = "";
        dropping = false;
        start = i + 1;
      }
      if (!dropping) {
        pending += text.slice(start);
        if (pending.length > MAX_RELEVANT_LINE) { pending = ""; dropping = true; }
      }
    }
  } finally { await fh.close(); }
  return { malformedCompleteLine };
}

async function inspectRollout(path, token, boundary) {
  const header = await readHeader(path);
  if (!header || !codexCwdInWorkspace(header.cwd, workspace)) return null;
  const state = {
    path,
    ...header,
    parentId: header.parentId,
    turnOpen: false,
    currentTurnId: null,
    inputBeforeTurn: null,
    turnInput: null,
    lifecycleTimestamp: null,
    malformedCompleteLine: false,
    latestStartedAt: null,
    model: header.model,
    modelContextWindow: undefined,
    parentActivity: new Set(),
    snapshotSize: boundary.boundary,
    snapshotFileSize: boundary.fileSize,
    snapshotFileIdentity: boundary.fileIdentity,
    incompleteAtBoundary: boundary.incomplete,
    liveRevision: liveTurnRevision.get(header.sid)?.revision ?? 0,
  };
  const scan = await scanRecords(path, obj => {
    if (obj?.type !== "event_msg") return;
    const payload = obj.payload ?? {};
    if (payload.type === "task_started") {
      const turnId = nonEmpty(payload.turn_id);
      const repeatedTurn = state.turnOpen && turnId && state.currentTurnId === turnId;
      state.turnOpen = true;
      state.currentTurnId = turnId;
      if (!repeatedTurn) state.turnInput = state.inputBeforeTurn;
      state.inputBeforeTurn = null;
      state.latestStartedAt = typeof obj.timestamp === "string" ? obj.timestamp : null;
      state.lifecycleTimestamp = Number.isFinite(Date.parse(obj.timestamp ?? "")) ? Date.parse(obj.timestamp) : null;
      if (typeof payload.model_context_window === "number") state.modelContextWindow = payload.model_context_window;
    } else if (payload.type === "task_complete" || payload.type === "turn_aborted") {
      const terminalTurnId = nonEmpty(payload.turn_id);
      if (!terminalTurnId || !state.currentTurnId || terminalTurnId === state.currentTurnId) {
        state.turnOpen = false;
        state.currentTurnId = null;
        state.inputBeforeTurn = null;
        state.turnInput = null;
        state.lifecycleTimestamp = Number.isFinite(Date.parse(obj.timestamp ?? "")) ? Date.parse(obj.timestamp) : null;
      }
    } else if (payload.type === "turn_context" && typeof payload.model === "string") {
      state.model = payload.model;
    }
    const activity = codexSubagentActivity(obj);
    if (activity?.kind === "started" && nonEmpty(activity.agent_thread_id)) {
      state.parentActivity.add(activity.agent_thread_id);
    }
    const input = userInput(obj);
    if (typeof input === "string" && input.trim()) {
      const candidate = { text: input, timestamp: typeof obj.timestamp === "string" ? obj.timestamp : null };
      if (state.turnOpen) state.turnInput = candidate;
      else state.inputBeforeTurn = candidate;
    }
  }, token, boundary.boundary);
  state.malformedCompleteLine = scan.malformedCompleteLine;
  return state;
}

async function collectBoundaries(token) {
  const boundaries = new Map();
  await walkRolloutDays(async (dir, files) => {
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      if (token !== generation || !enabled) return STOP;
      const path = join(dir, name);
      try {
        const initial = await stat(path);
        const boundary = await completeLineBoundary(path, initial.size);
        boundaries.set(path, { ...boundary, fileIdentity: fileIdentity(initial) });
      } catch { /* vanished during inventory */ }
    }
  }, { sessionsDir: CODEX_SESSIONS_DIR });
  return token === generation && enabled ? boundaries : null;
}

async function runScan(token, boundaries) {
  const byId = new Map();
  if (!boundaries) return;
  for (const [path, boundary] of boundaries) {
    if (token !== generation || !enabled) return;
    const record = await inspectRollout(path, token, boundary);
    if (!record) continue;
    const group = byId.get(record.sid) ?? [];
    group.push(record);
    byId.set(record.sid, group);
  }
  const sessions = new Map();
  for (const [id, records] of byId) {
    if (records.some(record => record.malformedCompleteLine || record.incompleteAtBoundary)) continue;
    let current = records[0];
    if (records.length > 1) {
      // A resumed thread can have more than one rollout. Resolve it only when
      // every observed lifecycle boundary has an unambiguous event time.
      if (records.some(record => record.lifecycleTimestamp == null)) continue;
      const latestAt = Math.max(...records.map(record => record.lifecycleTimestamp));
      const latest = records.filter(record => record.lifecycleTimestamp === latestAt);
      if (latest.some(record => record.turnOpen !== latest[0].turnOpen)) continue;
      current = latest[latest.length - 1];
    }
    if (current.turnOpen) sessions.set(id, current);
  }
  // An append after the inventory boundary belongs to the live watcher. Do not
  // seed from a stale prefix while that watcher is about to apply a newer stop.
  for (const [id, session] of sessions) {
    if (token !== generation || !enabled) return;
    const live = liveTurnRevision.get(id);
    let current;
    try { current = await stat(session.path ?? ""); } catch {}
    // Appends after the complete-line boundary belong to the live tail and do
    // not invalidate the prefix snapshot. Shrinks and file replacement still
    // do, as does any lifecycle transition observed by that tail.
    if (!current || current.size < session.snapshotFileSize ||
        !sameFileIdentity(fileIdentity(current), session.snapshotFileIdentity) ||
        (live?.revision ?? 0) !== session.liveRevision) sessions.delete(id);
  }
  if (token !== generation || !enabled) return;

  // Snapshot roots first. A child with no eligible parent remains a truthful
  // standalone root; it must not cause the reducer to invent an active parent.
  for (const session of sessions.values()) {
    if (emitted.has(session.sid)) continue;
    const payload = {
      session_id: session.sid,
      cwd: session.cwd,
      provider: "codex",
      hook_event_name: "SessionStart",
      startup_discovery: true,
    };
    if (session.timestamp) payload.timestamp = session.timestamp;
    if (session.model) payload.model = session.model;
    if (typeof session.modelContextWindow === "number") payload.model_context_window = session.modelContextWindow;
    if (session.turnInput?.text) {
      payload.startup_prompt = session.turnInput.text;
      if (session.turnInput.timestamp) payload.startup_prompt_timestamp = session.turnInput.timestamp;
    }
    pushEvent(payload, "codex", {
      replay: true,
      persist: false,
      receivedAt: Date.now(),
    });
    emitted.add(session.sid);
  }

  const edges = new Set();
  for (const parent of sessions.values()) {
    const childIds = new Set(parent.parentActivity);
    for (const child of sessions.values()) if (child.parentId === parent.sid) childIds.add(child.sid);
    for (const childId of childIds) {
      const child = sessions.get(childId);
      if (!child || child.sid === parent.sid) continue;
      const edge = `${parent.sid}\n${child.sid}`;
      if (edges.has(edge) || emitted.has(edge)) continue;
      const rel = {
        session_id: child.sid,
        parent_session_id: parent.sid,
        cwd: child.cwd,
        provider: "codex",
        runtime: "codex",
        hook_event_name: "CodexSubagentStart",
        startup_discovery: true,
      };
      if (child.model) rel.model = child.model;
      for (const key of ["agent_type", "agent_nickname", "agent_role"]) {
        if (child[key]) rel[key] = child[key];
      }
      pushEvent(rel, "codex", { replay: true, persist: false });
      edges.add(edge);
      emitted.add(edge);
    }
  }
}

function scheduleScan() {
  if (!enabled) return Promise.resolve();
  const token = generation;
  const previous = scanPromise;
  boundaryPromise = new Promise(resolve => { resolveBoundary = resolve; });
  const work = async () => {
    if (previous) await previous.catch(() => {});
    if (!enabled || token !== generation) return;
    const boundaries = await collectBoundaries(token);
    if (!boundaries || token !== generation || !enabled) return;
    startupBoundaries = boundaries;
    resolveBoundary?.(boundaries);
    resolveBoundary = null;
    await runScan(token, boundaries);
  };
  const current = work().catch(err => {
    console.warn(`ccdeck: Codex startup discovery failed: ${err?.message ?? err}`);
  }).finally(() => {
    resolveBoundary?.(null);
    resolveBoundary = null;
    if (scanPromise === current) scanPromise = null;
  });
  scanPromise = current;
  return current;
}

export function startCodexStartupDiscovery(cwd, on = true) {
  workspace = cwd ?? "";
  configured = true;
  desired = on === true;
  return setCodexStartupDiscovery(desired);
}

/** Toggle only the historical one-shot scan; the live Codex tail is separate. */
export function setCodexStartupDiscovery(on) {
  desired = on === true;
  if (!configured) return Promise.resolve();
  const next = desired;
  if (enabled === next) return scanPromise;
  enabled = next;
  generation++;
  if (enabled) return scheduleScan();
  startupBoundaries = null;
  resolveBoundary?.(null);
  resolveBoundary = null;
  return Promise.resolve();
}

export function stopCodexStartupDiscovery() {
  configured = false;
  enabled = false;
  generation++;
  startupBoundaries = null;
  boundaryPromise = Promise.resolve(null);
  resolveBoundary?.(null);
  resolveBoundary = null;
  return Promise.resolve();
}

/** The initial live-tail cursor must start where the history snapshot began. */
export function waitForCodexStartupBoundary() { return boundaryPromise; }

/** Cursor for a rollout present at boot, or a file created after inventory. */
export function codexStartupCursor(path, currentSize) {
  if (!startupBoundaries) return null;
  const boundary = startupBoundaries.get(path);
  return boundary === undefined
    ? { offset: 0, sawBeginning: true }
    : { offset: Math.min(boundary.boundary, currentSize), sawBeginning: false };
}

/** Called only by the live rollout tail, to prevent a stale startup seed. */
export function noteCodexLiveRecord(obj, sid) {
  if (obj?.type !== "event_msg") return;
  const type = obj.payload?.type;
  if (type !== "task_started" && type !== "task_complete" && type !== "turn_aborted") return;
  const previous = liveTurnRevision.get(sid);
  liveTurnRevision.delete(sid);
  liveTurnRevision.set(sid, {
    revision: (previous?.revision ?? 0) + 1,
    active: type === "task_started",
  });
  while (liveTurnRevision.size > MAX_LIVE_REVISIONS) {
    liveTurnRevision.delete(liveTurnRevision.keys().next().value);
  }
}
