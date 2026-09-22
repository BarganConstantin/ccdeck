// Our own hook entries from before there was a mark, and from a machine that
// spells its paths with backslashes.
//
// Every entry the installer writes carries `__agent-dag: true`, and dedupe finds
// it by that mark. Two kinds of machine have entries without one. A deck old
// enough to predate the mark left `.claude/ccgraph/hook.js` and
// `.claude/agent-flow/hook.js` entries behind under the two earlier names; and a
// settings.json written by hand, or by a tool, on Windows spells the same path
// `…\.claude\agent-dag\hook.js`. isOurEntry is the second chance: an entry whose
// command runs a hook.js out of one of our directories is ours whatever it is
// marked.
//
// WHAT WENT UNTESTED. Only the Codex forward-slash arm of that path check had
// ever run, once, from codex-leftover-hooks-983. The Claude arm in either slash
// form, the non-array `hooks` guard and the non-string `command` guard had zero
// hits — so a machine upgrading from a pre-marker version, or any Windows
// machine with an unmarked entry, could keep the old entry beside the new one.
// Both then fire for every Claude event: the same event posted twice, duplicate
// nodes on the canvas, and an `--uninstall` that reports success while a hook
// goes on running.
//
// The malformed groups are here for the same reason the real ones are. They
// belong to nobody — `hooks: "x"` is not something this installer ever wrote —
// and the rule for a group we cannot read is to leave it exactly where it is
// rather than to crash the boot that found it.
//
// TEMP HOME, set before the installer is imported, because it resolves the
// Claude config dir at module load. The pattern is codex-leftover-hooks-983's.
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-unmarked-hooks-"));
const FAKE_CLAUDE = join(DIR, "claude");
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = FAKE_CLAUDE;
process.env.CODEX_HOME = join(DIR, "codex");

// @ts-expect-error — plain .mjs module, no types
const installer = await import("../../server/installer.mjs");
const { CLAUDE_DIR, installHooks, uninstallHooks } = installer as {
  CLAUDE_DIR: string;
  installHooks: (o: { provider: string }) => Promise<{ changed: boolean }>;
  uninstallHooks: (o: { provider: string }) => Promise<{ ok: boolean; changed: boolean }>;
};

// Belt and braces: an installer that stopped honouring the environment would be
// rewriting the developer's own settings.json from here.
if (!resolve(CLAUDE_DIR).startsWith(resolve(DIR))) {
  throw new Error(`refusing to run: installer resolved ${CLAUDE_DIR}, outside ${DIR}`);
}

const SETTINGS = join(CLAUDE_DIR, "settings.json");

afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(DIR);
});

/** Theirs. Runs a hook.js, but out of a directory that is not one of ours. */
const theirs = { hooks: [{ type: "command", command: "node ~/.claude/my-hooks/hook.js" }] };

/** Ours, from before the mark existed: the deck's second name. */
const preMarker = { hooks: [{ type: "command", command: "node /home/u/.claude/agent-flow/hook.js" }] };

/** Ours, on Windows, spelled the way that machine spells a path. */
const backslashes = {
  hooks: [{ type: "command", command: '"C:\\node.exe" "C:\\Users\\u\\.claude\\agent-dag\\hook.js" --provider claude' }],
};

/** Not ours, not theirs, not anything: three shapes the installer never wrote.
 *  A string `hooks` is iterable and a number is not, so both are here — the
 *  first would be walked character by character without the array guard, and
 *  the second throws. */
const malformed = [{ hooks: "x" }, { hooks: 42 }, { hooks: [{ command: 42 }] }];

type Group = Record<string, unknown>;
const stop = (): Group[] => JSON.parse(readFileSync(SETTINGS, "utf8")).hooks?.Stop ?? [];
const commandsOf = (g: Group) =>
  (Array.isArray(g.hooks) ? g.hooks : []).map(h => (h as { command?: unknown }).command);

beforeEach(() => {
  mkdirSync(CLAUDE_DIR, { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify({
    // A real setting, so a rewrite that lost the rest of the file would be
    // visible here rather than only in settings-preserve.
    model: "opus",
    hooks: { Stop: [preMarker, backslashes, theirs, ...malformed] },
  }, null, 2) + "\n");
});

describe("an install on a machine whose entries predate the mark", () => {
  it("replaces them rather than adding a second hook beside them", async () => {
    await installHooks({ provider: "claude" });

    const groups = stop();
    // Exactly one of ours, and it is the one just written: marked, and running
    // the hook.js this install put on disk.
    const ours = groups.filter(g => g["__agent-dag"] === true);
    expect(ours).toHaveLength(1);
    expect(String(commandsOf(ours[0])[0])).toContain(join(CLAUDE_DIR, "agent-dag"));
    // And neither old spelling survived, which is the whole of the defect: two
    // entries here means every Stop event posted twice.
    const all = JSON.stringify(groups);
    expect(all).not.toContain("agent-flow");
    expect(all).not.toContain("\\\\.claude\\\\agent-dag\\\\hook.js");
  });

  it("leaves the user's own hook, and the groups nobody can read, where they were", async () => {
    await installHooks({ provider: "claude" });

    const groups = stop();
    expect(groups).toContainEqual(theirs);
    for (const g of malformed) expect(groups).toContainEqual(g);
    // Ours last, appended after what was kept, so the order the user sees is
    // their own entries followed by the deck's.
    expect(groups[groups.length - 1]).toMatchObject({ "__agent-dag": true });
    expect(JSON.parse(readFileSync(SETTINGS, "utf8")).model).toBe("opus");
  });

  it("does not refuse to boot over a group it cannot read", async () => {
    // FOUND BY THIS FILE. `{ "hooks": "x" }` in settings.json made the sound-hook
    // retirement that rides along inside installHooks throw
    // `TypeError: … .map is not a function` — on the install every boot runs
    // unconditionally, so the deck did not start at all, and the only thing the
    // user got was a stack naming neither the file nor the entry. Fixed in
    // retire-sound-hook.mjs by reading `hooks` the way installer.mjs always has.
    //
    // Seeded on its own, so this says "one unreadable group is enough" rather
    // than leaning on the fuller file above.
    writeFileSync(SETTINGS, JSON.stringify({ hooks: { Stop: [{ hooks: "x" }] } }, null, 2) + "\n");
    await expect(installHooks({ provider: "claude" })).resolves.toBeTruthy();
    expect(stop()).toContainEqual({ hooks: "x" });
  });
});

describe("an uninstall on the same machine", () => {
  it("takes out what it never marked, and says it changed something", async () => {
    const out = await uninstallHooks({ provider: "claude" });
    expect(out).toMatchObject({ ok: true, changed: true });

    const groups = stop();
    // Theirs and the two unreadable ones — nothing else. An uninstall that left
    // a pre-marker entry behind would report success while a hook kept firing.
    expect(groups).toEqual([theirs, ...malformed]);
  });

  it("reports nothing to do once they are gone, and changes nothing", async () => {
    await uninstallHooks({ provider: "claude" });
    const after = readFileSync(SETTINGS, "utf8");

    expect(await uninstallHooks({ provider: "claude" })).toMatchObject({ ok: true, changed: false });
    expect(readFileSync(SETTINGS, "utf8")).toBe(after);
  });
});
