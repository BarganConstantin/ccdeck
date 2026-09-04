// Two decks booting together, and the one that loses used to take the user's
// own hooks with it.
//
// `installHooks` reads settings.json at the top, computes a whole new object,
// and writes it if the JSON differs from the bytes it read. Two decks starting
// at once — the ordinary case on a machine where one is already running —
// interleave inside that window:
//
//   A reads, B reads (same bytes)
//   A restores the user's parked sound hooks into its object, writes, deletes
//     the parked file — its contents are now in settings.json
//   B, holding the pre-restore object and now reading an absent park, writes
//
// B's write is a lost update, and this one is not recoverable: the user's own
// `Stop` hook is gone from settings.json and from the parked file, which was
// its only other copy. The module's own header calls that "the one
// unrecoverable thing".
//
// The fix is a compare against the FILE at the last moment rather than against
// the snapshot. Declining is safe by construction: every boot reinstalls, the
// next one recomputes against the new bytes, and the entries this function adds
// are identical on both decks — so the loser has nothing of its own to lose.
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-lost-update-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
mkdirSync(join(DIR, "claude"), { recursive: true });
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
afterAll(() => rmTempDir(DIR));

// @ts-expect-error — .mjs server module, no types
const { installHooks, readSettingsForWrite, writeFileAtomic } = await import("../../server/installer.mjs");

const SETTINGS = join(DIR, "claude", "settings.json");
const read = () => JSON.parse(readFileSync(SETTINGS, "utf8"));

beforeEach(() => {
  writeFileSync(SETTINGS, JSON.stringify({ hooks: {} }, null, 2) + "\n");
});

describe("a settings.json another writer touched mid-install", () => {
  it("declines rather than overwriting what the other writer put there", async () => {
    // The other deck's write, landing exactly in the window between this one's
    // read and its write — through the seam installHooks exposes for it. Racing
    // by wall clock would pass or fail by how fast the machine is, which is the
    // shape of test that goes green on the developer's laptop and red on a
    // Windows runner.
    const theirs = {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Glass.aiff" }] }] },
    };
    const r = await installHooks({
      provider: "claude",
      beforeWrite: () => writeFileAtomic(SETTINGS, JSON.stringify(theirs, null, 2) + "\n"),
    });
    // The user's hook survived: this pass wrote nothing over it.
    expect(read().hooks.Stop[0].hooks[0].command).toBe("afplay /System/Library/Sounds/Glass.aiff");
    expect(r.changed).toBe(false);
    expect(r.raced).toBe(true);
  }, 30_000);

  it("installs normally when nothing else is writing", async () => {
    // The compare must not turn every ordinary boot into a no-op.
    const r = await installHooks({ provider: "claude" });
    expect(r.changed).toBe(true);
    const after = read();
    expect(Object.keys(after.hooks).length).toBeGreaterThan(0);
    const stop = after.hooks.Stop ?? [];
    expect(JSON.stringify(stop)).toContain("agent-dag");
  }, 30_000);

  it("converges on the next boot, which is what makes declining safe", async () => {
    // The loser recomputes against the new bytes and writes then. Here: the
    // race above left the user's hook in place, and a following install adds
    // the deck's entries beside it without touching it.
    await writeFileAtomic(SETTINGS, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Glass.aiff" }] }] },
    }, null, 2) + "\n");

    const r = await installHooks({ provider: "claude" });
    expect(r.changed).toBe(true);
    const stop = JSON.stringify(read().hooks.Stop);
    expect(stop, "the deck's own entry is missing").toContain("agent-dag");
    expect(stop, "the user's hook was dropped").toContain("Glass.aiff");
  }, 30_000);
});
