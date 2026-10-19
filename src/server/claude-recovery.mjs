import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeConfigDir, ccProjectSlug } from "./claude-dir.mjs";
import { canonicalCwd } from "./canonical-path.mjs";
import { codexCwdInWorkspace } from "./log-election.mjs";
import { readByteRange } from "./jsonl-chunks.mjs";
import { run } from "./exec.mjs";
import { heldPrefs, prefsRead } from "./prefs-state.mjs";
import { pushEvent } from "./event-sink.mjs";
import { outputWatch, touchSession } from "./session-tracking.mjs";
import { maybeResolveContext, maybeResolveModel, maybeResolveUsage } from "./session-enrichment.mjs";

const FILE_LIMIT = 128;
const REGISTRY_BYTES = 64 * 1024;
const TRANSCRIPT_BYTES = 256 * 1024;
const normalizeStart = value => typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

/** PID existence alone cannot distinguish a reused PID from the old process. */
export async function claudeProcessStarts(pids) {
  const starts = new Map();
  // The registry's POSIX lstart fingerprint has no verified Windows equivalent.
  // Unsupported identity formats are deliberately left to normal live hooks.
  if (!["darwin", "linux"].includes(process.platform) || !pids.length) return starts;
  const result = await run("ps", ["-p", pids.join(","), "-o", "pid=,lstart="], {
    timeout: 1500, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: "C" },
  });
  starts.complete = result.ok || (result.code === 1 && !result.stderr.trim());
  // ps exits 1 when all candidates are gone; partial output is still useful.
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match) starts.set(Number(match[1]), normalizeStart(match[2]));
  }
  return starts;
}

async function registry(path) {
  let file;
  try {
    file = await open(path, "r");
    const info = await file.stat();
    if (!info.isFile() || info.size > REGISTRY_BYTES) return null;
    const bytes = Buffer.alloc(info.size);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } catch { return null; }
  finally { await file?.close(); }
}

export async function claudeRecoveryPrompt(path) {
  try {
    const info = await stat(path);
    const from = Math.max(0, info.size - TRANSCRIPT_BYTES);
    let text = await readByteRange(path, from, info.size);
    if (from) text = text.slice(text.indexOf("\n") + 1);
    const end = text.lastIndexOf("\n");
    if (end < 0) return {};
    let prompt, model;
    for (const line of text.slice(0, end).split("\n")) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.isSidechain) continue;
      if (row?.type === "assistant" && typeof row.message?.model === "string") model = row.message.model;
      if (row?.type !== "user") continue;
      const content = row.message?.content;
      const value = typeof content === "string" ? content : Array.isArray(content)
        ? content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n") : "";
      if (value) prompt = value;
    }
    return { prompt, model };
  } catch { return {}; }
}

/** Bounded discovery plus status reconciliation for the sessions it recovered. */
export function createClaudeRecovery({ workspace = "", home = claudeConfigDir(),
  platform = process.platform, starts = claudeProcessStarts, emit = pushEvent,
  enrich = raw => {
    outputWatch.note(raw.session_id, raw.transcript_path);
    touchSession(raw.session_id);
    maybeResolveModel(raw); maybeResolveUsage(raw); maybeResolveContext(raw);
  }, enabled = () => heldPrefs.current().recoverClaudeSessions !== false } = {}) {
  let stopped = false, pending = null, startupEnabled, startupFiles;
  const startupIdentities = new Map();
  const tracked = new Map();
  async function scanOnce() {
    await prefsRead;
    startupEnabled ??= enabled();
    if (stopped || !startupEnabled) return;
    const observedAt = Date.now();
    let files;
    try {
      startupFiles ??= (await readdir(join(home, "sessions"))).filter(name => /^\d+\.json$/.test(name)).sort().slice(0, FILE_LIMIT);
      files = startupFiles;
    }
    catch { return; }
    const candidates = [];
    for (const name of files) {
      const path = join(home, "sessions", name);
      const row = await registry(path);
      if (!row || row.pid !== Number(name.slice(0, -5)) || !Number.isSafeInteger(row.pid) || row.pid <= 0 ||
        row.pidDomain !== platform || !normalizeStart(row.procStart) ||
        typeof row.sessionId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(row.sessionId) ||
        typeof row.cwd !== "string" || !row.cwd) continue;
      const identity = `${row.pid}:${row.procStart}:${row.sessionId}`;
      if (startupIdentities.has(path) && startupIdentities.get(path) !== identity) continue;
      startupIdentities.set(path, identity);
      const cwd = await canonicalCwd(row.cwd);
      if (!codexCwdInWorkspace(cwd, workspace)) continue;
      candidates.push({ path, row, cwd });
    }
    const identities = await starts([...new Set([...candidates.map(c => c.row.pid), ...[...tracked.values()].filter(t => t.active).map(t => t.pid)])]);
    for (const [sid, prior] of tracked) {
      if (!prior.active || stopped) continue;
      const actual = identities.get(prior.pid);
      if ((actual && actual !== normalizeStart(prior.procStart)) || (!actual && identities.complete === true)) {
        emit({ hook_event_name: "ClaudeSessionRecovered", provider: "claude", session_id: sid,
          cwd: prior.cwd, snapshot_observed_at: observedAt, recovery_active: false, recovery_session_closed: true,
        }, "hook", { replay: true, persist: false });
        prior.active = false;
      }
    }
    candidates.sort((a, b) => (Number(b.row.updatedAt) || 0) - (Number(a.row.updatedAt) || 0));
    const selected = new Set();
    for (const { path, row, cwd } of candidates) {
      if (stopped) return;
      if (identities.get(row.pid) !== normalizeStart(row.procStart)) continue;
      if (selected.has(row.sessionId)) continue;
      selected.add(row.sessionId);
      const previous = tracked.get(row.sessionId);
      if (row.status !== "busy" && row.status !== "idle") continue;
      const active = row.status === "busy";
      if (previous?.active === active) continue;
      const transcript = join(home, "projects", ccProjectSlug(row.cwd), `${row.sessionId}.jsonl`);
      const facts = active ? await claudeRecoveryPrompt(transcript) : {};
      // A hook/status update can overtake the transcript read.
      const latest = await registry(path);
      if (!latest || latest.sessionId !== row.sessionId || latest.pid !== row.pid ||
        latest.procStart !== row.procStart || latest.status !== row.status || latest.updatedAt !== row.updatedAt) continue;
      if (stopped) return;
      emit({ hook_event_name: "ClaudeSessionRecovered", provider: "claude", session_id: row.sessionId,
        cwd, snapshot_observed_at: observedAt, recovery_active: active, ...facts,
      }, "hook", { replay: true, persist: false });
      tracked.set(row.sessionId, { active, pid: row.pid, procStart: row.procStart, cwd });
      if (active) enrich({ session_id: row.sessionId, cwd, transcript_path: transcript });
    }
  }
  return {
    scan() { return pending ??= scanOnce().finally(() => { pending = null; }); },
    stop() { stopped = true; },
  };
}
