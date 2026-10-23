// Settings › Claude Code's server half (claude-settings.mjs): what each row of
// the short list reads as on a machine, and the one write that changes a row
// in the user's settings.json — against a scratch home, never the real one.
import { afterEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
import { readClaudeSettings, readLegacyValues, safeDisplay, SETTINGS_BACKUP, updateClaudeSetting } from "../../server/claude-settings.mjs";
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
import { deckDataDir } from "../../server/deck-home.mjs";
import { CLAUDE_SETTINGS } from "../../server/claude-settings-catalog.mjs";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

type Row = {
  id: string; value: unknown; isSet: boolean; editable: boolean; reason?: string; lockedBy?: string; custom?: boolean;
  override?: { env: string; value: string; where: string; effect: string };
};
type Reading = { settings: Row[]; present: Record<string, string> | null; claudeVersion: string | null; userFile: string; fileShown: string };

/** A scratch home with a ~/.claude, a managed directory of its own and a
 *  Claude Code of a chosen version. */
async function fixture({ version = "2.1.309" as string | null, env = {} as Record<string, string>, legacy = undefined as Record<string, boolean> | undefined } = {}) {
  const home = await mkdtemp(join(tmpdir(), "claude-settings-")); dirs.push(home);
  const dir = join(home, ".claude"); await mkdir(dir);
  const managed = join(home, "etc-claude-code"); await mkdir(managed);
  const path = join(dir, "settings.json");
  const remap = (file: string) => file.startsWith("/etc/claude-code/") ? join(managed, file.slice("/etc/claude-code/".length)) : file;
  const options = {
    home, env, platform: "linux",
    readJson: async (file: string) => JSON.parse(await readFile(remap(file), "utf8")),
    list: async (dir: string) => (await import("node:fs/promises")).readdir(remap(dir)),
    versions: () => version ? [version] : [],
    ...(legacy ? { readLegacy: async () => legacy } : {}),
  };
  const read = async () => (await readClaudeSettings(options)) as Reading;
  const row = async (id: string) => (await read()).settings.find(r => r.id === id)!;
  const onDisk = async () => JSON.parse(await readFile(path, "utf8"));
  return { home, dir, managed, path, options, read, row, onDisk };
}

describe("reading the short list", () => {
  it("reads every row as Claude Code's default where no file names it, all of them changeable", async () => {
    const { read } = await fixture();
    const state = await read();
    expect(state.settings.map(r => r.id)).toEqual(CLAUDE_SETTINGS.map(e => e.id));
    expect(state.settings.every(r => r.editable && !r.isSet)).toBe(true);
    expect(state.settings.find(r => r.id === "cleanupPeriodDays")!.value).toBe(30);
    expect(state.settings.find(r => r.id === "listAgents")!.value).toBe(true);
    expect(state.settings.find(r => r.id === "crossSessionInbound")!.value).toBeNull();
    expect(state.claudeVersion).toBe("2.1.309");
    // No settings.json at all is Claude Code on its defaults, said as such.
    expect(state).toMatchObject({ userFile: "absent", present: {}, fileShown: "~/.claude/settings.json" });
  });

  it("reads what the user file sets, and shows the page only values of a safe kind", async () => {
    const { path, read } = await fixture();
    await writeFile(path, JSON.stringify({
      crossSessionInbound: "refuse", cleanupPeriodDays: 90, attribution: false, spinnerTipsEnabled: false,
      permissions: { deny: ["Bash(rm:*)", "ListAgents"] },
      env: { ANTHROPIC_API_KEY: "sk-secret" }, apiKeyHelper: "/bin/print-my-key", theme: "dark", model: "opus",
    }));
    const state = await read();
    const by = (id: string) => state.settings.find(r => r.id === id)!;
    expect(by("crossSessionInbound")).toMatchObject({ value: "refuse", isSet: true });
    expect(by("cleanupPeriodDays")).toMatchObject({ value: 90, isSet: true });
    expect(by("attribution")).toMatchObject({ value: false, isSet: true });
    expect(by("listAgents")).toMatchObject({ value: false, isSet: true });
    expect(by("spinnerTipsEnabled")).toMatchObject({ value: false, isSet: true });
    expect(state.present).toMatchObject({ theme: "dark", env: "set", apiKeyHelper: "set", model: "set", permissions: "set", cleanupPeriodDays: "90" });
    expect(JSON.stringify(state)).not.toContain("sk-secret");
    expect(JSON.stringify(state)).not.toContain("print-my-key");
  });

  it("locks a row an administrator decides, in a managed file, a drop-in or the cached organization settings", async () => {
    const { dir, managed, path, row } = await fixture();
    await writeFile(path, JSON.stringify({ autoUpdatesChannel: "stable" }));
    await writeFile(join(managed, "managed-settings.json"), JSON.stringify({ autoUpdatesChannel: "latest" }));
    await mkdir(join(managed, "managed-settings.d"));
    await writeFile(join(managed, "managed-settings.d", "10-sessions.json"), JSON.stringify({ permissions: { deny: ["ListAgents"] } }));
    await writeFile(join(dir, "remote-settings.json"), JSON.stringify({ autoMemoryEnabled: false }));
    expect(await row("autoUpdatesChannel")).toMatchObject({ value: null, lockedBy: "managed", editable: false, isSet: false });
    expect(await row("listAgents")).toMatchObject({ value: false, lockedBy: "managed", editable: false });
    expect(await row("autoMemoryEnabled")).toMatchObject({ value: false, lockedBy: "organization", editable: false });
    expect((await row("autoMemoryEnabled")).reason).toContain("administrator");
    expect(await row("spinnerTipsEnabled")).toMatchObject({ editable: true });
  });

  it("locks the deny-rule row where only managed permission rules apply", async () => {
    const { managed, row } = await fixture();
    await writeFile(join(managed, "managed-settings.json"), JSON.stringify({ allowManagedPermissionRulesOnly: true }));
    expect(await row("listAgents")).toMatchObject({ editable: false, lockedBy: "managed" });
  });

  it("shows no value at all from a settings.json it cannot read, and says Claude Code skips it", async () => {
    const { path, read } = await fixture({ env: { DISABLE_AUTO_COMPACT: "1" } });
    await writeFile(path, "{ // a comment Claude Code itself would refuse\n  \"spinnerTipsEnabled\": false }");
    const state = await read();
    expect(state).toMatchObject({ userFile: "invalid", present: null });
    expect(state.settings.every(r => !r.editable && r.value === null && !r.override && r.reason === state.settings[0].reason)).toBe(true);
    expect(state.settings[0].reason).toContain("not valid JSON, so Claude Code skips all of it");
    await writeFile(path, "[1, 2]");
    expect((await read()).userFile).toBe("invalid");
  });

  it("says a settings.json the deck cannot open is not read, rather than calling it empty", async () => {
    const { path, read } = await fixture();
    await mkdir(path);
    const state = await read();
    expect(state).toMatchObject({ userFile: "unreadable", present: null });
    expect(state.settings.every(r => r.value === null && !r.editable)).toBe(true);
    expect(state.settings[0].reason).toContain("could not be read here");
  });

  it("shows the user's own values but changes nothing while the organization's settings cannot be read", async () => {
    const { dir, path, read } = await fixture();
    await writeFile(path, JSON.stringify({ spinnerTipsEnabled: false }));
    await writeFile(join(dir, "remote-settings.json"), "{broken");
    const state = await read();
    expect(state.userFile).toBe("read");
    expect(state.settings.find(r => r.id === "spinnerTipsEnabled")).toMatchObject({ value: false, editable: false });
    expect(state.settings.every(r => r.reason === "Your organization's settings could not be read, so nothing here can be changed until they can.")).toBe(true);
  });

  it("holds a row back from a Claude Code too old to read what it writes", async () => {
    const old = await fixture({ version: "2.1.200" });
    expect(await old.row("crossSessionInbound")).toMatchObject({ editable: false, reason: "Needs Claude Code 2.1.224 or newer." });
    expect(await old.row("attribution")).toMatchObject({ editable: false, reason: "Needs Claude Code 2.1.281 or newer." });
    expect(await old.row("spinnerTipsEnabled")).toMatchObject({ editable: true });
    const ancient = await fixture({ version: "2.0.50" });
    expect((await ancient.read()).settings.every(r => !r.editable && r.reason === "Needs Claude Code 2.1.101 or newer.")).toBe(true);
  });

  it("writes no row that needs a newer Claude Code while the version here cannot be read", async () => {
    const unknown = await fixture({ version: null });
    for (const entry of CLAUDE_SETTINGS) {
      const row = await unknown.row(entry.id);
      if (entry.since) {
        expect(row, entry.id).toMatchObject({ editable: false });
        expect(row.reason, entry.id).toBe(`Needs Claude Code ${entry.since} or newer, and the version installed here could not be read.`);
      } else {
        expect(row, entry.id).toMatchObject({ editable: true });
      }
    }
  });

  it("reads the update channel `claude install latest` writes as Latest, not as a custom value", async () => {
    const { path, row } = await fixture();
    await writeFile(path, JSON.stringify({ autoUpdatesChannel: "latest" }));
    expect(await row("autoUpdatesChannel")).toMatchObject({ value: null, isSet: true, editable: true });
    expect((await row("autoUpdatesChannel")).custom).toBeUndefined();
  });

  it("reads attribution as off where only the older includeCoAuthoredBy turns it off", async () => {
    const { path, managed, row } = await fixture();
    await writeFile(path, JSON.stringify({ includeCoAuthoredBy: false }));
    expect(await row("attribution")).toMatchObject({ value: false, isSet: true, editable: true });
    await writeFile(path, JSON.stringify({ includeCoAuthoredBy: true }));
    expect(await row("attribution")).toMatchObject({ value: true });
    await writeFile(join(managed, "managed-settings.json"), JSON.stringify({ includeCoAuthoredBy: false }));
    expect(await row("attribution")).toMatchObject({ value: false, lockedBy: "managed", editable: false });
  });

  it("reads a turn-duration choice an older Claude Code kept in ~/.claude.json while no settings file sets it", async () => {
    const kept = await fixture({ legacy: { showTurnDuration: false } });
    expect(await kept.row("showTurnDuration")).toMatchObject({ value: false, isSet: false, editable: true });
    await writeFile(kept.path, JSON.stringify({ showTurnDuration: true }));
    expect(await kept.row("showTurnDuration")).toMatchObject({ value: true, isSet: true });
    // Only the rows the reference says fall back to it.
    const other = await fixture({ legacy: { spinnerTipsEnabled: false } as Record<string, boolean> });
    expect(await other.row("spinnerTipsEnabled")).toMatchObject({ value: true });
  });

  it("says under a row which variable outranks it, from where, for the first source that sets it", async () => {
    const { path, managed, row } = await fixture({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0", DISABLE_UPDATES: "true", DISABLE_AUTO_COMPACT: "0" } });
    await writeFile(path, JSON.stringify({ env: { CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: "1", ANTHROPIC_API_KEY: "sk-secret" } }));
    expect((await row("fileCheckpointingEnabled")).override).toEqual({ env: "CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING", value: "1", where: "user", effect: "Off" });
    expect((await row("autoMemoryEnabled")).override).toEqual({ env: "CLAUDE_CODE_DISABLE_AUTO_MEMORY", value: "0", where: "environment", effect: "On" });
    expect((await row("autoUpdatesChannel")).override).toEqual({ env: "DISABLE_UPDATES", value: "true", where: "environment", effect: "Updates are off" });
    // A value that does not turn it off is no override.
    expect((await row("autoCompactEnabled")).override).toBeUndefined();
    // The row stays changeable: the line says what wins, the switch what the file holds.
    expect(await row("fileCheckpointingEnabled")).toMatchObject({ value: true, editable: true });
    // A settings file's env is applied over the environment, the administrator's first.
    await writeFile(join(managed, "managed-settings.json"), JSON.stringify({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } }));
    expect((await row("autoMemoryEnabled")).override).toEqual({ env: "CLAUDE_CODE_DISABLE_AUTO_MEMORY", value: "1", where: "managed", effect: "Off" });
    const plain = await fixture();
    expect((await plain.read()).settings.some(r => r.override)).toBe(false);
  });

  it("shows a value the control cannot express, and will not write over it", async () => {
    const { path, row, options } = await fixture();
    await writeFile(path, JSON.stringify({ attribution: { commit: "Made with care", pr: "" }, cleanupPeriodDays: "abc" }));
    expect(await row("attribution")).toMatchObject({ custom: true, editable: false });
    expect(await row("cleanupPeriodDays")).toMatchObject({ custom: true, editable: false });
    await expect(updateClaudeSetting("attribution", false, options)).rejects.toThrow("custom value");
  });
});

describe("changing a row", () => {
  it("writes the one key, keeps every other key, hooks and secrets included, and keeps the file it replaced", async () => {
    const { home, path, onDisk, options } = await fixture();
    const original = { hooks: { Stop: [{ hooks: [{ type: "command", command: "x", __agentDag: true }] }] }, env: { ANTHROPIC_API_KEY: "sk-secret" }, theme: "dark" };
    const before = JSON.stringify(original, null, 4);
    await writeFile(path, before);
    await updateClaudeSetting("spinnerTipsEnabled", false, options);
    expect(await onDisk()).toEqual({ ...original, spinnerTipsEnabled: false });
    const backup = join(deckDataDir("linux", {}, home), SETTINGS_BACKUP);
    expect(await readFile(backup, "utf8")).toBe(before);
    if (process.platform !== "win32") expect((await stat(backup)).mode & 0o777).toBe(0o600);
  });

  it("removes the key when the row goes back to Claude Code's default, rather than writing the default", async () => {
    const { path, onDisk, options } = await fixture();
    await writeFile(path, JSON.stringify({ theme: "dark", spinnerTipsEnabled: false, cleanupPeriodDays: 90, autoUpdatesChannel: "stable" }));
    await updateClaudeSetting("spinnerTipsEnabled", true, options);
    await updateClaudeSetting("cleanupPeriodDays", 30, options);
    await updateClaudeSetting("autoUpdatesChannel", null, options);
    expect(await onDisk()).toEqual({ theme: "dark" });
  });

  it("adds and removes only its own deny rule", async () => {
    const { path, onDisk, options } = await fixture();
    await writeFile(path, JSON.stringify({ permissions: { allow: ["Read"], deny: ["Bash(rm:*)"] } }));
    await updateClaudeSetting("listAgents", false, options);
    expect(await onDisk()).toEqual({ permissions: { allow: ["Read"], deny: ["Bash(rm:*)", "ListAgents"] } });
    await updateClaudeSetting("listAgents", true, options);
    expect(await onDisk()).toEqual({ permissions: { allow: ["Read"], deny: ["Bash(rm:*)"] } });
    await writeFile(path, JSON.stringify({ permissions: { deny: ["ListAgents"] } }));
    await updateClaudeSetting("listAgents", true, options);
    expect(await onDisk()).toEqual({});
  });

  it("writes attribution off as false and on as no key", async () => {
    const { path, onDisk, options } = await fixture();
    await writeFile(path, "{}");
    await updateClaudeSetting("attribution", false, options);
    expect(await onDisk()).toEqual({ attribution: false });
    await updateClaudeSetting("attribution", true, options);
    expect(await onDisk()).toEqual({});
  });

  it("turns attribution back on by removing the older includeCoAuthoredBy too, and writes nothing to turn off what it already turns off", async () => {
    const { path, onDisk, options } = await fixture();
    await writeFile(path, JSON.stringify({ includeCoAuthoredBy: false, theme: "dark" }));
    await updateClaudeSetting("attribution", false, options);
    expect(await readFile(path, "utf8")).toBe(JSON.stringify({ includeCoAuthoredBy: false, theme: "dark" }));
    await updateClaudeSetting("attribution", true, options);
    expect(await onDisk()).toEqual({ theme: "dark" });
  });

  it("writes a turn-duration choice out where removing the key would bring back the one ~/.claude.json keeps", async () => {
    const { path, onDisk, options } = await fixture({ legacy: { showTurnDuration: false } });
    await writeFile(path, "{}");
    await updateClaudeSetting("showTurnDuration", true, options);
    expect(await onDisk()).toEqual({ showTurnDuration: true });
    await updateClaudeSetting("showTurnDuration", false, options);
    expect(await onDisk()).toEqual({});
  });

  it("refuses an id or a value the table does not offer, and a locked row, leaving the file as it was", async () => {
    const { managed, path, options } = await fixture();
    await writeFile(path, '{"theme":"dark"}');
    await expect(updateClaudeSetting("theme", "light", options)).rejects.toThrow("Choose a setting");
    await expect(updateClaudeSetting("crossSessionInbound", "maybe", options)).rejects.toThrow("Choose a setting");
    await expect(updateClaudeSetting("spinnerTipsEnabled", "false", options)).rejects.toThrow("Choose a setting");
    await expect(updateClaudeSetting("cleanupPeriodDays", 0, options)).rejects.toThrow("Choose a setting");
    await writeFile(join(managed, "managed-settings.json"), JSON.stringify({ spinnerTipsEnabled: true }));
    await expect(updateClaudeSetting("spinnerTipsEnabled", false, options)).rejects.toThrow("organization");
    expect(await readFile(path, "utf8")).toBe('{"theme":"dark"}');
  });

  it("refuses to rewrite a file it cannot read as JSON", async () => {
    const { path, options } = await fixture();
    await writeFile(path, "{broken");
    await expect(updateClaudeSetting("spinnerTipsEnabled", false, options)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("{broken");
  });

  it("does not create a file to say what the default already says", async () => {
    const { path, options } = await fixture();
    await updateClaudeSetting("spinnerTipsEnabled", true, options);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await updateClaudeSetting("spinnerTipsEnabled", false, options);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ spinnerTipsEnabled: false });
  });

  it("lands two changes made at once", async () => {
    const { path, onDisk, options } = await fixture();
    await writeFile(path, "{}");
    await Promise.all([updateClaudeSetting("spinnerTipsEnabled", false, options), updateClaudeSetting("crossSessionInbound", "hold", options)]);
    expect(await onDisk()).toEqual({ spinnerTipsEnabled: false, crossSessionInbound: "hold" });
  });

  it("keeps a symlinked settings.json a symlink", async () => {
    if (process.platform === "win32") return;
    const { home, path, options } = await fixture();
    const real = join(home, "dotfiles-settings.json");
    await writeFile(real, "{}");
    await symlink(real, path);
    await updateClaudeSetting("showTurnDuration", false, options);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, "utf8"))).toEqual({ showTurnDuration: false });
  });
});

describe("the values an older Claude Code kept in ~/.claude.json", () => {
  it("reads only the keys that still fall back to it, again when the file changes", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-legacy-")); dirs.push(home);
    const state = join(home, ".claude.json");
    const opts = { home, env: {}, platform: "linux" };
    expect(await readLegacyValues(opts)).toEqual({});
    await writeFile(state, JSON.stringify({ showTurnDuration: false, spinnerTipsEnabled: false, oauthAccount: { emailAddress: "a@b.c" } }));
    expect(await readLegacyValues(opts)).toEqual({ showTurnDuration: false });
    await writeFile(state, JSON.stringify({ showTurnDuration: true }));
    await utimes(state, new Date(), new Date(Date.now() + 5000));
    expect(await readLegacyValues(opts)).toEqual({ showTurnDuration: true });
    await writeFile(state, "{not json");
    await utimes(state, new Date(), new Date(Date.now() + 10_000));
    expect(await readLegacyValues(opts)).toEqual({});
  });
});

describe("what the page may see of a value", () => {
  it("shows Booleans, numbers and a documented choice, and nothing of any other value", () => {
    expect(safeDisplay("verbose", true)).toBe("true");
    expect(safeDisplay("cleanupPeriodDays", 7)).toBe("7");
    expect(safeDisplay("theme", "light")).toBe("light");
    expect(safeDisplay("theme", "custom:secret-slug")).toBe("set");
    expect(safeDisplay("model", "opus")).toBe("set");
    expect(safeDisplay("env", { TOKEN: "x" })).toBe("set");
  });
});
