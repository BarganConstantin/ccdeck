// The deck's own folders, and any missing folder above them, are made 0700 by
// every writer that makes them.
//
// The optional engine is used only where no folder above it can be changed by
// another account (pro-engine-install.mjs). It is installed in the deck's data
// folder, and the writers that made that folder, or ~/.local/share above it,
// asked for the default mode: under a 0002 umask (Ubuntu's default) that is
// 0775, and on a machine whose group is shared every engine in it was refused.
// So each writer that makes the data folder, the log folder or the agent-dag
// folder (the data folder when CLAUDE_CONFIG_DIR is set) asks for 0700. Node
// gives that mode to every folder the call creates and to no other: a folder
// that is already there keeps its mode.
//
// ~/.agents-deck, beside the data folder, holds the tools the deck downloads
// and runs (uv, ccusage, macmon), the Radar capture script that root runs, and
// the deck's markers and logs. Its writers ask for 0700 too, so that under
// the same umask nobody else in the group can swap a tool the deck then runs.
//
// Two halves. The first runs real writers against folders that do not exist
// yet, under a 0002 umask, and reads the modes back. It is gated off Windows,
// which has no POSIX mode to read and ignores the one asked for. The second
// reads the sources, on every leg: each recursive mkdir in the deck's server,
// CLI and desktop host names 0700, or is on a short list of folders that are
// not the data folder or above it, each with its reason. A new writer that
// forgets goes red there.
//
// Nothing here reaches the user's own folders: HOME, the Claude and Codex
// folders and the deck's home are all inside one temporary folder, checked
// before anything is imported.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-private-folders-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CCDECK_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.XDG_DATA_HOME = join(DIR, "share");
process.env.XDG_STATE_HOME = join(DIR, "state");
for (const k of ENV_KEYS) if (!resolve(process.env[k]!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${k}`);

// @ts-expect-error plain server module
const { writeDeckName } = await import("../../server/session-deck-names.mjs");
// @ts-expect-error plain server module
const { setNextChoice } = await import("../../server/cswap-auto-choice.mjs");
// @ts-expect-error plain server module
const { applyCodexAuto } = await import("../../server/codex-auto.mjs");
// @ts-expect-error plain server module
const { createToolAudit } = await import("../../server/tool-audit.mjs");
// @ts-expect-error plain server module
const { openEventLog } = await import("../../server/event-log.mjs");
// @ts-expect-error plain server module
const { writeStore } = await import("../../server/browser-watch-store.mjs");
// @ts-expect-error plain server module
const { appendLog } = await import("../../server/browser-watch-log.mjs");
// @ts-expect-error plain server module
const { appendSwap } = await import("../../server/swap-log.mjs");
// @ts-expect-error plain server module
const { capturePreferences } = await import("../../server/traffic-radar-monitor.mjs");
// @ts-expect-error plain desktop module
const { writeLauncher } = await import("../../../desktop/deck-host.mjs");

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
  rmTempDir(DIR);
});

const mode = (path: string) => statSync(path).mode & 0o777;

/** A temporary folder with nothing below it yet. */
const fresh = () => mkdtempSync(join(DIR, "w-"));

/** Every folder from `from`, the first one the writer had to make, down to `to`. */
function made(from: string, to: string): string[] {
  const out = [to];
  while (out[0] !== from) {
    const up = dirname(out[0]);
    if (up === out[0]) throw new Error(`${from} is not above ${to}`);
    out.unshift(up);
  }
  return out;
}

function expectPrivate(writer: string, from: string, to: string) {
  for (const folder of made(from, to)) expect(mode(folder), `${writer}: ${relative(DIR, folder)}`).toBe(0o700);
}

describe.skipIf(process.platform === "win32")("the folders the deck's writers make", () => {
  // Ubuntu's default, the one that gave 0775. The runner's own umask (0022)
  // would still tell 0700 from the default 0755 if this could not be set.
  let umask: number | null = null;
  beforeAll(() => {
    try { umask = process.umask(0o002); } catch { umask = null; }
  });
  afterAll(() => {
    if (umask !== null) process.umask(umask);
  });

  it("are 0700 for the data folder and each folder above it they make", async () => {
    let t = fresh();
    let data = join(t, "a", "b", "deck");
    await writeDeckName("claude", "session-1", "Notes", { path: join(data, "session-names.json") });
    expectPrivate("session names", join(t, "a"), data);

    t = fresh();
    data = join(t, "a", "b", "deck");
    process.env.CCDECK_HOME = data;
    try {
      expect(await setNextChoice("weekly")).toEqual({ ok: true });
    } finally {
      process.env.CCDECK_HOME = join(DIR, "deck");
    }
    expectPrivate("Auto-switch choice", join(t, "a"), data);

    t = fresh();
    data = join(t, "a", "b", "deck");
    expect((await applyCodexAuto({ action: "enable", enabled: true }, { store: data })).ok).toBe(true);
    expectPrivate("Codex Auto-switch", join(t, "a"), data);

    t = fresh();
    const audit = join(t, "a", "b", "deck", "tool-audit");
    await createToolAudit({ dir: audit }).start();
    expectPrivate("tool activity", join(t, "a"), audit);
  });

  it("are 0700 for the log folder and each folder above it", async () => {
    const t = fresh();
    const log = join(t, "a", "state", "ccdeck");
    await openEventLog(join(log, "events.jsonl"));
    expectPrivate("event log", join(t, "a"), log);
  });

  it("are 0700 for agent-dag, the data folder under CLAUDE_CONFIG_DIR, and each folder above it", async () => {
    let t = fresh();
    let claude = join(t, "a", "claude");
    await writeStore({ settings: {}, episodes: [], dismissed: [] }, claude);
    expectPrivate("Browser Watch state", join(t, "a"), join(claude, "agent-dag", "browser-watch"));

    t = fresh();
    claude = join(t, "a", "claude");
    await appendLog([{ host: "example.test", startMs: 1_700_000_000_000, endMs: 1_700_000_000_000, count: 1, urls: [] }], claude);
    expectPrivate("Browser Watch log", join(t, "a"), join(claude, "agent-dag", "browser-watch"));

    t = fresh();
    claude = join(t, "a", "claude");
    writeLauncher("/opt/ccdeck-test/ccdeck", { env: { CLAUDE_CONFIG_DIR: claude }, platform: process.platform });
    expectPrivate("desktop launcher", join(t, "a"), join(claude, "agent-dag"));
  });

  it("are 0700 for ~/.agents-deck and each folder below it they make", async () => {
    let t = fresh();
    let tools = join(t, "a", ".agents-deck");
    await appendSwap({ at: 1_700_000_000_000, slot: 1 }, join(tools, "log", "account-active.jsonl"));
    expectPrivate("account switch log", join(t, "a"), join(tools, "log"));

    t = fresh();
    tools = join(t, "a", ".agents-deck");
    await capturePreferences(tools).write(4317, { enabled: true });
    expectPrivate("Radar preferences", join(t, "a"), tools);
  });

  it("leave a folder that is already there as it is", async () => {
    // Above: a shared folder the deck did not make keeps its 0775, and only
    // the two below it, which the write made, are 0700.
    const above = fresh();
    chmodSync(above, 0o775);
    await writeDeckName("claude", "session-1", "Notes", { path: join(above, "b", "deck", "session-names.json") });
    expect(mode(above)).toBe(0o775);
    expectPrivate("session names", join(above, "b"), join(above, "b", "deck"));

    // The data folder itself, made 0755 by an older deck: it stays 0755
    // (the engine's install tightens that one folder on its own).
    const t = fresh();
    const data = join(t, "deck");
    mkdirSync(data);
    chmodSync(data, 0o755);
    await writeDeckName("claude", "session-1", "Notes", { path: join(data, "session-names.json") });
    expect(mode(data)).toBe(0o755);
  });
});

// ── the sources ─────────────────────────────────────────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CODE = /\.(?:mjs|cjs|js)$/;

/** The deck's server and CLI, all of them, and the desktop host's own files
 *  (not its build scripts). */
function sources(): string[] {
  const walk = (dir: string, deep: boolean): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return deep && e.name !== "node_modules" && e.name !== "__tests__" ? walk(p, deep) : [];
    return CODE.test(e.name) ? [p] : [];
  });
  return [...walk(join(ROOT, "src", "server"), true), ...walk(join(ROOT, "bin"), true), ...walk(join(ROOT, "desktop"), false)];
}

/** A mkdir with `recursive: true`, one call to a line as every writer here is
 *  written: the folder it makes, and the options it makes it with. */
const CALL = /\b(?:mkdir|mkdirSync|mk|makeDir)\((.*?),\s*\{([^{}]*\brecursive:\s*true\b[^{}]*)\}/g;
const PRIVATE = /\bmode:\s*(?:0o700|DIR_MODE)\b/;

function recursiveMkdirs() {
  const found: { file: string; folder: string; private: boolean }[] = [];
  const unread: string[] = [];
  for (const path of sources()) {
    const file = relative(ROOT, path).split("\\").join("/");
    readFileSync(path, "utf8").split("\n").forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      const calls = [...line.matchAll(CALL)];
      for (const m of calls) found.push({ file, folder: m[1].trim(), private: PRIVATE.test(m[2]) });
      // A mkdir and `recursive` on one line that the pattern did not read is a
      // writer this file would otherwise pass without looking at.
      if (!calls.length && /\b(?:mkdir|mkdirSync|mk|makeDir)\(/.test(line) && /\brecursive\b/.test(line)) unread.push(`${file}:${i + 1}`);
    });
  }
  return { found, unread };
}

/** Folders a deck writer makes that are not the deck's own (the data, log and
 *  agent-dag folders, ~/.agents-deck) or above them, and so keep the default
 *  mode. File, then the folder as written. */
const NOT_THE_DECKS: Record<string, string> = {
  "desktop/login-item.mjs dirname(path)": "the desktop's autostart folder",
  "src/server/login-service.mjs dirOf(path)": "the service manager's folder (LaunchAgents, systemd's user units)",
  "src/server/claude-settings.mjs paths.dir": "Claude Code's own settings folder",
  "src/server/traffic-radar-config.mjs dir": "Claude Code's own settings folder",
  "src/server/codex-terminal.mjs join(rc, '..')": "the folder of the shell's startup file",
};

describe("the writers of the deck's folders, as written", () => {
  it("name 0700 for every folder they make, apart from folders that are not the deck's own", () => {
    const { found, unread } = recursiveMkdirs();
    expect(unread, "mkdir calls this scan cannot read").toEqual([]);
    const plain = [...new Set(found.filter((c) => !c.private).map((c) => `${c.file} ${c.folder}`))].sort();
    // Exactly the list: a writer missing from it goes red, and so does an
    // entry whose writer is gone or now names 0700.
    expect(plain).toEqual(Object.keys(NOT_THE_DECKS).sort());
    // The scan reads the writers this rule is about, not only the exceptions.
    const named = found.filter((c) => c.private).map((c) => `${c.file} ${c.folder}`);
    expect(named).toEqual(expect.arrayContaining([
      "src/server/deck-home.mjs dir",
      "src/server/tool-audit.mjs dir",
      "src/server/event-log.mjs pdirname(persistPath)",
      "src/server/installer.mjs p",
      "desktop/deck-host.mjs dir",
      "src/server/uv-bootstrap.mjs TOOL_DIR",
      "src/server/ccusage-registry.mjs root",
      "src/server/traffic-radar-permission.mjs directory",
    ]));
  });
});
