import { codexThreadLink } from "./codex-lineage.mjs";
import { turnContextEffort } from "./codex-translate.mjs";
import { stat } from "node:fs/promises";
import { readAppendedLines } from "./jsonl-chunks.mjs";

export const RECOVERY_TAIL_BYTES = 8 * 1024 * 1024;
export const RECOVERY_FILE_LIMIT = 128;
export const RECOVERY_SCAN_BYTES = 32 * 1024 * 1024;
export const RECOVERY_RECENT_MS = 24 * 60 * 60 * 1000;

/** A fixed prefix of an existing file. The live watcher resumes at offset. */
export async function readCodexRecovery(path, initial, sid, cwd, factsBefore = Infinity) {
  const from = Math.max(0, initial.size - RECOVERY_TAIL_BYTES);
  const cursor = { offset: from, midLine: from > 0 };
  const result = { active: false, at: null, turnId: null, prompt: undefined,
    model: undefined, usage: undefined, window: undefined, effort: undefined,
    approval: undefined, contextTokens: undefined, offset: initial.size, certain: true, links: [] };
  let pendingPrompt;
  { // The entire bounded tail fits in one reader chunk; never reread a partial suffix.
    const { text, advanced } = await readAppendedLines(path, cursor, initial.size);
    if (!advanced && initial.size > from) result.certain = false;
    let lineEnd = cursor.offset - Buffer.byteLength(text) - 1;
    for (const line of text.split("\n")) {
      lineEnd += Buffer.byteLength(line) + 1;
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { result.certain = false; continue; }
      const link = codexThreadLink(row, sid, cwd);
      if (link) result.links.push(link);
      const p = row?.payload;
      if (row?.type === "turn_context") {
        if (typeof p?.model === "string") result.model = p.model;
        result.effort = turnContextEffort(p);
        if (typeof p?.approval_policy === "string") result.approval = p.approval_policy;
      }
      if (row?.type !== "event_msg" || !p) continue;
      if (p.type === "task_started") {
        if (!result.active || result.turnId !== p.turn_id) result.prompt = pendingPrompt;
        pendingPrompt = undefined;
        result.active = true;
        result.turnId = typeof p.turn_id === "string" ? p.turn_id : null;
        result.at = Date.parse(row.timestamp);
        if (typeof p.model_context_window === "number") result.window = p.model_context_window;
      } else if (p.type === "task_complete" || p.type === "turn_aborted") {
        if (!p.turn_id || !result.turnId || p.turn_id === result.turnId) {
          result.active = false;
          result.prompt = pendingPrompt = undefined;
          result.turnId = null;
          result.at = Date.parse(row.timestamp);
        }
      } else if (p.type === "token_count") {
        if (p.info?.total_token_usage) result.usage = p.info.total_token_usage;
        if (typeof p.info?.last_token_usage?.total_tokens === "number") result.contextTokens = p.info.last_token_usage.total_tokens;
        if (typeof p.info?.model_context_window === "number") result.window = p.info.model_context_window;
      }
      const prompt = p.type === "user_message" && typeof p.message === "string" ? p.message
        : p.item?.type === "UserMessage" && Array.isArray(p.item.content)
          ? p.item.content.map(part => typeof part?.text === "string" ? part.text : "").join("") : null;
      if (prompt && lineEnd <= factsBefore) {
        if (result.active) result.prompt = prompt;
        else pendingPrompt = prompt;
      }
    }
  }
  result.offset = cursor.offset;
  // An incomplete final line might be the completion. Keep it for the tail,
  // but do not call this snapshot active until the evidence is complete.
  if (cursor.offset !== initial.size) result.certain = false;
  const current = await stat(path);
  if (current.size !== initial.size || current.dev !== initial.dev || current.ino !== initial.ino) result.certain = false;
  return result;
}

/** Repeated rollouts of a resumed thread must agree on the newest boundary. */
export function latestCodexRecovery(candidates) {
  if (!candidates.length || candidates.some(c => !c.snapshot.certain)) return null;
  if (candidates.length === 1) return candidates[0];
  if (candidates.some(c => !Number.isFinite(c.snapshot.at))) return null;
  const newest = Math.max(...candidates.map(c => c.snapshot.at));
  const sameTime = candidates.filter(c => c.snapshot.at === newest);
  if (sameTime.some(c => c.snapshot.active !== sameTime[0].snapshot.active)) return null;
  return sameTime[sameTime.length - 1];
}
