// Which Codex skill a rollout line shows in use, for Skill activity (#2181).
//
// Codex writes no record of its own that a skill ran. Two things in a rollout
// say so anyway:
//
//   - the `<skill>` message Codex injects when a person picks one with `$name`
//     or /skills, which it writes only once the skill has loaded (explicit);
//   - the model reading a skill's SKILL.md, or running one of its scripts, which
//     is Codex's own rule for a skill it chose itself (detected).
//
// A detected use counts only for a skill in the catalog Codex gave that session
// (its `<skills_instructions>` message) and only when the command succeeded, so
// searching for SKILL.md files or reading a Claude skill is not a use. One use
// per turn and skill: the turn id is the row's key, which also lands a forked
// rollout's copy of its parent's turns on the rows the parent already wrote.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { noteSkillUse } from "./tool-audit.mjs";
import { readByteRange } from "./jsonl-chunks.mjs";

// The catalog sits in the first lines of a rollout, a few tens of KB in.
const CATALOG_HEAD_BYTES = 512 * 1024;
const slashes = path => path.replace(/\\/g, "/");

/** The skills a `<skills_instructions>` message lists: SKILL.md path → name,
 *  and each skill's folder for its scripts. Null when the text has none. */
export function parseSkillCatalog(text) {
  const start = typeof text === "string" ? text.indexOf("<skills_instructions>") : -1;
  if (start < 0) return null;
  const roots = new Map(), files = new Map(), dirs = [];
  const end = text.indexOf("</skills_instructions>", start);
  for (const line of text.slice(start, end < 0 ? undefined : end).split("\n")) {
    const root = /^- `(r\d+)` = `(.+)`\s*$/.exec(line);
    if (root) { roots.set(root[1], slashes(root[2]).replace(/\/+$/, "")); continue; }
    const entry = /^- (\S+): .*\(file: (r\d+)\/([^()]*\/SKILL\.md)\)\s*$/.exec(line);
    if (!entry || !roots.has(entry[2])) continue;
    const file = `${roots.get(entry[2])}/${slashes(entry[3])}`;
    files.set(file, entry[1]);
    dirs.push([file.slice(0, -"SKILL.md".length), entry[1]]);
  }
  return files.size ? { files, dirs } : null;
}

/** The catalog a rollout began with, for a session this deck joined late. */
export async function readCodexSkillCatalog(path) {
  try {
    const head = await readByteRange(path, 0, CATALOG_HEAD_BYTES);
    for (const line of head.split("\n")) {
      if (!line.includes("<skills_instructions>")) continue;
      return parseSkillCatalog(messageText(JSON.parse(line)?.payload));
    }
  } catch {}
  return null;
}

function messageText(payload) {
  if (payload?.type !== "message" || !Array.isArray(payload.content)) return "";
  return payload.content.map(part => typeof part?.text === "string" ? part.text : "").join("\n");
}

const localPath = value => {
  if (typeof value !== "string" || !value) return null;
  try { return value.startsWith("file://") ? fileURLToPath(value) : value; } catch { return null; }
};

/** A finished command that may have touched a skill: worth reading the catalog for. */
const commandItem = obj => {
  const item = obj?.type === "event_msg" && obj.payload?.type === "item_completed" ? obj.payload.item : null;
  return item?.type === "CommandExecution" && item.exit_code === 0 && Array.isArray(item.parsed_cmd) ? item : null;
};

/** Per-rollout state: the catalog (undefined until known, null for none), the
 *  turn the last `task_started` opened, and the turn-and-skill keys counted. */
export const codexSkillState = () => ({ catalog: undefined, turn: null, seen: new Set(), waiting: [], loading: false });

/**
 * The skill uses one rollout line shows, as `{ key, name, origin, at }`.
 * `skills` is the rollout's codexSkillState. A command names its own turn; the
 * injected `<skill>` message names none and belongs to the turn just opened.
 */
export function codexSkillUses(obj, skills) {
  const pl = obj?.payload;
  const at = typeof obj?.timestamp === "string" ? Date.parse(obj.timestamp) : undefined;
  if (obj?.type === "event_msg" && pl?.type === "task_started" && typeof pl.turn_id === "string") { skills.turn = pl.turn_id; return []; }
  const turn = (typeof pl?.turn_id === "string" ? pl.turn_id : skills.turn) ?? `at:${obj?.timestamp ?? ""}`;
  const use = (name, origin) => {
    const key = `${turn}|${name}`;
    if (skills.seen.has(key)) return [];
    if (skills.seen.size >= 256) skills.seen.clear();
    skills.seen.add(key);
    return [{ key, name, origin, at }];
  };
  if (obj?.type === "response_item" && pl?.type === "message") {
    const text = messageText(pl);
    if (pl.role === "developer" && text.includes("<skills_instructions>")) { skills.catalog = parseSkillCatalog(text); return []; }
    if (pl.role !== "user") return [];
    return [...text.matchAll(/<skill>\s*<name>([^<]+)<\/name>/g)].flatMap(m => use(m[1].trim(), "typed"));
  }
  const item = commandItem(obj);
  if (!item || !skills.catalog) return [];
  const cwd = localPath(item.cwd);
  const found = [];
  for (const parsed of item.parsed_cmd) {
    if (parsed?.type === "read" && typeof parsed.path === "string") {
      const name = skills.catalog.files.get(slashes(cwd ? resolve(cwd, parsed.path) : parsed.path));
      if (name) found.push(name);
    } else if (parsed?.type === "unknown" && typeof parsed.cmd === "string") {
      const cmd = slashes(parsed.cmd);
      for (const [dir, name] of skills.catalog.dirs) if (cmd.includes(`${dir}scripts/`)) found.push(name);
    }
  }
  return [...new Set(found)].flatMap(name => use(name, "detected"));
}

/**
 * Count the skills one rollout line shows. `state` is the watcher's cursor for
 * the rollout: its session, cwd, subagent link and path. A command that may
 * read a skill, in a session joined after its catalog went by, waits for the
 * catalog to be read off the head of the file.
 */
export function noteCodexSkills(obj, state, note = noteSkillUse) {
  const skills = state.skills ??= codexSkillState();
  const session = state.link?.parent_session_id ?? state.sid, cwd = state.cwd, subagent = !!state.link;
  const send = uses => { for (const use of uses) note({ ...use, session, cwd, subagent }); };
  if (skills.catalog === undefined && commandItem(obj) && state.path) {
    skills.waiting.push(obj);
    if (!skills.loading) {
      skills.loading = true;
      void readCodexSkillCatalog(state.path).then(catalog => {
        if (skills.catalog === undefined) skills.catalog = catalog;
        for (const line of skills.waiting.splice(0)) send(codexSkillUses(line, skills));
      });
    }
    return;
  }
  send(codexSkillUses(obj, skills));
}
