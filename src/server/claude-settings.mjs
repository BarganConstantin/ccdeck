// Settings › Claude Code: what the short list of Claude Code settings
// (claude-settings-catalog.mjs) reads as on this machine, and the one write
// that changes one of them in the user's settings.json.
//
// THE USER FILE IS THE ONLY ONE WRITTEN. Claude Code reads settings from five
// places, and the four others are not the deck's to touch: managed settings
// and the cached organization settings belong to an administrator, and a
// project's .claude/settings.json and settings.local.json belong to that
// project. Those two are read anyway, the administrator's ones, so a row they
// decide says so and offers no control; a project file can still override a
// row in that project, which the section says once rather than on every row.
//
// WHAT IS SENT TO THE PAGE. A value is sent only where the table or the
// generated index (claude-settings-index.json) says what kind of value the
// key holds and the value is one of the safe kinds: a Boolean, a number, or a
// string from the key's own list of choices. Everything else in the file —
// env blocks, helper commands, URLs, tokens — is reported as present and
// nothing more, because the deck has no business carrying it into a page.
import { readFileSync } from "node:fs";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { createTemp, readSettingsForWrite, renameWithRetry, writeFileAtomic } from "./atomic-write.mjs";
import { CLAUDE_SETTINGS, claudeSettingById } from "./claude-settings-catalog.mjs";
import { claudeCodeVersions, claudeConfigDir, claudeVersionAtLeast } from "./claude-dir.mjs";
import { deckDataDir } from "./deck-home.mjs";
import { managedSettingsPath, readBoundedJson } from "./traffic-radar-config.mjs";

/** Before this Claude Code ignored a whole settings.json that held a key it
 *  did not know (installer.mjs), so the section changes nothing below it. */
export const WRITABLE_SINCE = "2.1.101";

/** The file the last state before each change is kept in, in the deck's own
 *  directory, mode 0600: settings.json can hold API keys in its env block. */
export const SETTINGS_BACKUP = "claude-settings.before-change.json";

let indexCache = null;
/** The generated list of every key Claude Code documents, read once. */
export function settingsIndex() {
  if (!indexCache) {
    try { indexCache = JSON.parse(readFileSync(new URL("./claude-settings-index.json", import.meta.url), "utf8")); }
    catch { indexCache = { keys: [] }; }
  }
  return indexCache;
}

const isObject = value => !!value && typeof value === "object" && !Array.isArray(value);

/** The oldest Claude Code found on disk, or null when none says its version. */
export function oldestClaudeVersion(versions) {
  let oldest = null;
  for (const version of versions) if (!oldest || !claudeVersionAtLeast(version, oldest)) oldest = version;
  return oldest;
}

function files({ home, env, platform }) {
  const join = platform === "win32" ? win32.join : posix.join;
  const dir = claudeConfigDir(env, home, platform);
  const managed = managedSettingsPath(platform, env);
  const managedDir = (platform === "win32" ? win32 : posix).dirname(managed);
  return {
    dir,
    user: join(dir, "settings.json"),
    organization: join(dir, "remote-settings.json"),
    managed,
    dropIns: join(managedDir, "managed-settings.d"),
  };
}

/** Every drop-in file an administrator put beside managed-settings.json,
 *  which Claude Code merges with it. A directory that exists and cannot be
 *  listed is a source the deck cannot vouch for. */
async function readDropIns(dir, join, readJson, list) {
  let names;
  try { names = await list(dir); }
  catch (error) { return error?.code === "ENOENT" ? [] : [{ status: "unavailable", settings: {} }]; }
  return Promise.all(names.filter(n => n.endsWith(".json")).sort().map(n => readSource(join(dir, n), readJson)));
}

async function readSource(path, readJson) {
  try {
    const settings = await readJson(path);
    return isObject(settings) ? { status: "read", settings } : { status: "unavailable", settings: {} };
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "absent" : "unavailable", settings: {} };
  }
}

const denies = (settings, tool) => {
  const deny = settings?.permissions?.deny;
  return Array.isArray(deny) && deny.includes(tool);
};

/** Whether a file decides this row: names its key, or for a tool row, denies
 *  the tool. */
function decides(entry, settings) {
  if (entry.kind === "allowTool") return denies(settings, entry.tool);
  return Object.hasOwn(settings, entry.key);
}

/** What the row's control shows for a settings object: a switch's Boolean, a
 *  choice's string or null, a day count. `custom` marks a value the row's
 *  control cannot express, which it shows but will not overwrite. */
function rowValue(entry, settings) {
  const raw = settings[entry.key];
  switch (entry.kind) {
    case "allowTool": return { value: !denies(settings, entry.tool) };
    case "attribution":
      if (raw === undefined) return { value: true };
      if (raw === false) return { value: false };
      return { value: true, custom: true };
    case "switch":
      if (raw === undefined) return { value: entry.unset };
      return typeof raw === "boolean" ? { value: raw } : { value: entry.unset, custom: true };
    case "days":
      if (raw === undefined) return { value: entry.unset };
      return Number.isInteger(raw) && raw >= 1 ? { value: raw } : { value: entry.unset, custom: true };
    case "choice": {
      if (raw === undefined) return { value: null };
      return entry.options.some(o => o.value === raw) ? { value: raw } : { value: null, custom: true };
    }
    default: return { value: null, custom: true };
  }
}

/** A top-level value of the user file as the page may see it (see the header). */
export function safeDisplay(key, raw, index = settingsIndex()) {
  if (typeof raw === "boolean") return String(raw);
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  const known = index.keys.find(k => k.key === key);
  if (typeof raw === "string" && known?.options?.includes(raw)) return raw;
  return "set";
}

/**
 * Every row of the table as this machine reads it.
 *
 * `editable` is false, with the reason in words, while a file that could
 * decide the row cannot be read, while an administrator's file decides it,
 * while the Claude Code on this machine is too old to read what it writes, or
 * while the user file holds a value the control cannot express.
 */
export async function readClaudeSettings({
  home = homedir(), env = process.env, platform = process.platform,
  readJson = readBoundedJson, list = readdir, versions = () => claudeCodeVersions({ home, env, platform }),
} = {}) {
  const paths = files({ home, env, platform });
  const [user, organization, managedFile, dropIns] = await Promise.all([
    readSource(paths.user, readJson), readSource(paths.organization, readJson), readSource(paths.managed, readJson),
    readDropIns(paths.dropIns, platform === "win32" ? win32.join : posix.join, readJson, list),
  ]);
  // The administrator's files as one: the drop-ins merged over the main file,
  // as Claude Code reads them, with every file's deny rules kept.
  const managedParts = [managedFile, ...dropIns];
  const managed = {
    status: managedParts.some(p => p.status === "unavailable") ? "unavailable" : managedParts.some(p => p.status === "read") ? "read" : "absent",
    settings: Object.assign({}, ...managedParts.map(p => p.settings)),
  };
  const deny = managedParts.flatMap(p => Array.isArray(p.settings.permissions?.deny) ? p.settings.permissions.deny : []);
  if (deny.length) managed.settings.permissions = { ...managed.settings.permissions, deny };
  const found = versions();
  const oldest = oldestClaudeVersion(found);
  const tooOld = oldest !== null && !claudeVersionAtLeast(oldest, WRITABLE_SINCE);
  const uncertain = [user, organization, managed].some(s => s.status === "unavailable");
  const rulesManagedOnly = managed.settings.allowManagedPermissionRulesOnly === true;

  const settings = CLAUDE_SETTINGS.map(entry => {
    const lockedBy = decides(entry, managed.settings) ? "managed"
      : decides(entry, organization.settings) ? "organization"
      : entry.kind === "allowTool" && rulesManagedOnly ? "managed" : null;
    const shown = lockedBy ? rowValue(entry, lockedBy === "managed" ? managed.settings : organization.settings) : rowValue(entry, user.settings);
    const behind = entry.since && oldest !== null && !claudeVersionAtLeast(oldest, entry.since);
    const unknownVersion = entry.strict && oldest === null;
    const reason = uncertain ? "Settings could not be read. Nothing can be changed until they can."
      : lockedBy ? "Set by your organization. Ask your administrator to change it."
      : tooOld ? `Needs Claude Code ${WRITABLE_SINCE} or newer.`
      : behind ? `Needs Claude Code ${entry.since} or newer.`
      : unknownVersion ? `Needs Claude Code ${entry.since} or newer, and the version installed here could not be read.`
      : shown.custom ? "Your settings.json holds a custom value. Edit it there."
      : null;
    return {
      id: entry.id, value: shown.value, isSet: !lockedBy && decides(entry, user.settings),
      ...(shown.custom ? { custom: true } : {}), ...(lockedBy ? { lockedBy } : {}),
      editable: reason === null, ...(reason ? { reason } : {}),
    };
  });

  const present = {};
  if (user.status === "read") for (const [key, raw] of Object.entries(user.settings)) present[key] = safeDisplay(key, raw);

  return {
    ok: true,
    claudeVersion: oldest,
    file: paths.user,
    sources: [
      { name: "User settings", status: user.status },
      { name: "Cached organization settings", status: organization.status },
      { name: "Managed settings", status: managed.status },
    ],
    settings,
    present,
  };
}

/** Whether `value` is one this row can write, by its kind. */
function acceptable(entry, value) {
  switch (entry.kind) {
    case "switch": case "allowTool": case "attribution": return typeof value === "boolean";
    case "choice": return entry.options.some(o => o.value === value);
    case "days": return Number.isInteger(value) && value >= 1 && value <= 36_500;
    default: return false;
  }
}

/** The user settings with the row set to `value`, or a reason it cannot be.
 *  The value Claude Code uses when the key is absent removes the key. */
function applied(entry, value, current) {
  const settings = { ...current };
  if (entry.kind === "allowTool") {
    const permissions = settings.permissions;
    if (permissions !== undefined && !isObject(permissions)) return { error: "Your settings.json has a permissions value that is not an object. No changes were saved." };
    const deny = permissions?.deny;
    if (deny !== undefined && !Array.isArray(deny)) return { error: "Your settings.json has a permissions.deny value that is not a list. No changes were saved." };
    const list = deny ?? [];
    if (value) {
      if (!list.includes(entry.tool)) return { settings };
      const kept = list.filter(rule => rule !== entry.tool);
      const next = { ...permissions };
      if (kept.length) next.deny = kept; else delete next.deny;
      if (Object.keys(next).length) settings.permissions = next; else delete settings.permissions;
      return { settings };
    }
    if (list.includes(entry.tool)) return { settings };
    settings.permissions = { ...permissions, deny: [...list, entry.tool] };
    return { settings };
  }
  if (entry.kind === "attribution") {
    if (current.attribution !== undefined && current.attribution !== false) return { error: "Your settings.json holds a custom attribution. Edit it there." };
    if (value) delete settings.attribution; else settings.attribution = false;
    return { settings };
  }
  if (entry.kind === "switch" || entry.kind === "days") {
    if (value === entry.unset) delete settings[entry.key]; else settings[entry.key] = value;
    return { settings };
  }
  if (value === null) delete settings[entry.key]; else settings[entry.key] = value;
  return { settings };
}

async function writePrivate(path, text) {
  const { tmp, handle } = await createTemp(path, { mode: 0o600 });
  try {
    try { await handle.writeFile(text, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await renameWithRetry(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

class SettingsRefusal extends Error {}

// One write at a time, so two rows changed in quick succession both land.
let settingsWrite = Promise.resolve();

/**
 * Set one row of the table in the user's settings.json.
 *
 * Read, change one key, write, through the same atomic write every settings
 * writer in the deck uses (atomic-write.mjs), and only when the row is
 * editable now — the check is made again here, not trusted from the page. The
 * file as it was is kept in the deck's directory first. When the file changed
 * on disk between the read and the write — Claude Code's own /config writes
 * here too — the whole change is made again from the new file, once, rather
 * than written over it.
 */
export function updateClaudeSetting(id, value, options = {}) {
  const write = settingsWrite.catch(() => {}).then(async () => {
    const entry = typeof id === "string" ? claudeSettingById(id) : undefined;
    if (!entry || !acceptable(entry, value)) throw new SettingsRefusal("Choose a setting this section offers and one of its values.");
    const state = await readClaudeSettings(options);
    const row = state.settings.find(r => r.id === entry.id);
    if (!row.editable) throw new SettingsRefusal(row.reason);
    const { home = homedir(), env = process.env, platform = process.platform } = options;
    const paths = files({ home, env, platform });
    for (let attempt = 0; attempt < 2; attempt++) {
      let read;
      try { read = await readSettingsForWrite(paths.user); }
      catch { throw new SettingsRefusal("Your settings.json could not be read as JSON. No changes were saved."); }
      const next = applied(entry, value, read.settings);
      if (next.error) throw new SettingsRefusal(next.error);
      const text = JSON.stringify(next.settings, null, 2) + "\n";
      if (JSON.stringify(next.settings) === JSON.stringify(read.settings)) return readClaudeSettings(options);
      const again = await readSettingsForWrite(paths.user).catch(() => null);
      if (!again || again.raw !== read.raw) continue;
      if (read.raw !== null) {
        const backupDir = deckDataDir(platform, env, home);
        await mkdir(backupDir, { recursive: true });
        await writePrivate((platform === "win32" ? win32.join : posix.join)(backupDir, SETTINGS_BACKUP), read.raw);
      }
      await mkdir(paths.dir, { recursive: true });
      await writeFileAtomic(paths.user, text);
      return readClaudeSettings(options);
    }
    throw new SettingsRefusal("Your settings.json changed while saving. Nothing was written. Try again.");
  });
  settingsWrite = write;
  return write;
}

export { SettingsRefusal };
