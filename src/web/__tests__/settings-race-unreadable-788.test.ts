// Two paths rewrite settings.json from a snapshot, and both could destroy the
// user's own hooks.
//
// #788. `installHooks` grew a compare-against-the-file check at the last moment
// because two decks booting together interleave inside the window between its
// read and its write, and the loser is "unrecoverable rather than merely
// stale": deck A restores the user's hand-written sound hooks out of the parked
// file and deletes the park, deck B writes a settings object computed before
// that restore, and the hook is gone from settings.json AND from the only other
// copy of it.
//
// The guard was written and then defeated by its own error handling:
//
//     const { raw: onDisk } = await readSettingsForWrite(path).catch(() => ({ raw: before }));
//     if (onDisk !== before) { … decline … }
//
// A failed re-read substituted the snapshot, so `onDisk !== before` was false
// and the write went ahead. ENOENT — the one case where substituting is right —
// never reaches that catch: `readSettingsForWrite` returns `{ raw: null }` for
// it without throwing. What does reach it is EACCES/EBUSY on a file written
// microseconds ago, which is the condition the module's own header names, and
// which happens precisely when another deck has just written it. The guard was
// blindest at the exact moment it was needed.
//
// `uninstallHooks` rewrites the same file from a snapshot read just as long ago
// and had no guard at all. Its race is `ccdeck --uninstall` against a deck that
// is starting, with the same ending and an exit code of 0.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withoutComments } from "./tsx-scan";

/** What the next `readFile` of settings.json should do instead of reading it.
 *  One shot: consumed by the first call that matches, so a case can make the
 *  guard's re-read fail without touching the read at the top. */
const { fsCtl } = vi.hoisted(() => ({ fsCtl: { failNextRead: "" as string, reads: 0 } }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    readFile: async (p: never, ...rest: never[]) => {
      if (String(p).endsWith("settings.json")) {
        fsCtl.reads++;
        if (fsCtl.failNextRead) {
          const code = fsCtl.failNextRead;
          fsCtl.failNextRead = "";
          const err = new Error(`${code}: permission denied, open`) as NodeJS.ErrnoException;
          err.code = code;
          throw err;
        }
      }
      return actual.readFile(p, ...rest);
    },
  };
});

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-settings-race-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, ".claude");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
afterAll(() => rmTempDir(DIR));

// @ts-expect-error — plain .mjs server module, no types
const { installHooks, uninstallHooks } = await import("../../server/installer.mjs");

const settingsPath = () => join(DIR, ".claude", "settings.json");

/** The user's own file, with a hook of theirs the deck must never eat. */
function seed(extra: Record<string, unknown> = {}) {
  mkdirSync(join(DIR, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify({
    hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "afplay ~/mine.aiff" }] }] },
    ...extra,
  }, null, 2) + "\n");
}

const onDisk = () => readFileSync(settingsPath(), "utf8");

beforeEach(() => { fsCtl.failNextRead = ""; fsCtl.reads = 0; });

describe("the install's last-moment guard", () => {
  it("declines when the re-read cannot be performed, instead of writing", async () => {
    // The defect exactly. The first read succeeds and the guard's re-read is
    // refused the way a scanner refuses it — which used to mean "unchanged".
    seed();
    const before = onDisk();
    // The install reads once at the top; make the SECOND read fail.
    const res = await installHooks({
      provider: "claude",
      beforeWrite: () => { fsCtl.failNextRead = "EACCES"; },
    });
    expect(res.raced, `the install wrote anyway: ${JSON.stringify(res)}`).toBe(true);
    expect(res.changed).toBe(false);
    expect(onDisk(), "the user's file was rewritten from a stale snapshot").toBe(before);
  });

  it("still declines when the re-read succeeds and shows a different file", async () => {
    // The case the guard already handled, kept so a fix for the one above
    // cannot quietly drop it.
    seed();
    const res = await installHooks({
      provider: "claude",
      beforeWrite: () => {
        const cur = JSON.parse(onDisk());
        cur.hooks.Stop.push({ matcher: "", hooks: [{ type: "command", command: "say done" }] });
        writeFileSync(settingsPath(), JSON.stringify(cur, null, 2) + "\n");
      },
    });
    expect(res.raced).toBe(true);
    expect(onDisk()).toContain("say done");
  });

  it("writes normally when nothing raced it", async () => {
    // And the case that must keep working, or the guard is just a broken
    // install. The user's own hook survives beside the deck's entries.
    seed();
    const res = await installHooks({ provider: "claude" });
    expect(res.raced ?? false).toBe(false);
    expect(res.changed).toBe(true);
    expect(onDisk(), "the deck ate the user's hook").toContain("afplay ~/mine.aiff");
    expect(onDisk()).toContain("agent-dag");
  });
});

describe("the uninstall, which had no guard at all", () => {
  it("declines when the re-read cannot be performed", async () => {
    // Deterministic, through the same `beforeWrite` seam installHooks carries
    // and for the reason it gives: this window is filled with real fs work, so
    // racing it by wall clock would pass or fail by how fast the machine is.
    seed();
    await installHooks({ provider: "claude" });
    const before = onDisk();
    const res = await uninstallHooks({
      provider: "claude",
      beforeWrite: () => { fsCtl.failNextRead = "EBUSY"; },
    });
    expect(res.ok, `the uninstall wrote anyway: ${JSON.stringify(res)}`).toBe(false);
    expect(res.reason).toBe("raced");
    expect(onDisk(), "it declined and still wrote").toBe(before);
    // And it says so rather than answering ok with changed:false, which would
    // read as "there was nothing to remove" — nothing retries an uninstall.
    expect(res.message).toMatch(/changed while uninstalling/);
  });

  it("declines when another writer changed the file under it", async () => {
    seed();
    await installHooks({ provider: "claude" });
    const res = await uninstallHooks({
      provider: "claude",
      beforeWrite: () => {
        const cur = JSON.parse(onDisk());
        cur.hooks.Stop.push({ matcher: "", hooks: [{ type: "command", command: "say raced" }] });
        writeFileSync(settingsPath(), JSON.stringify(cur, null, 2) + "\n");
      },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("raced");
    expect(onDisk(), "the racer's change was overwritten").toContain("say raced");
    expect(onDisk(), "the deck's entries were removed from a stale snapshot").toContain("agent-dag");
  });

  it("removes the deck's entries and leaves the user's alone when nothing races", async () => {
    seed();
    await installHooks({ provider: "claude" });
    expect(onDisk()).toContain("agent-dag");
    const res = await uninstallHooks({ provider: "claude" });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(onDisk(), "the uninstall ate the user's own hook").toContain("afplay ~/mine.aiff");
    expect(onDisk()).not.toContain("agent-dag");
  });
});

describe("the shape of both guards", () => {
  it("never substitutes the snapshot for a read that failed", () => {
    // The one-line spelling that reintroduces this, refused by name. It reads
    // as defensive and is the opposite.
    // Through withoutComments, because the module explains the trap in prose
    // directly above the fix — and a check that cannot tell the warning from
    // the mistake would fail on the file that gets it right. browser-history's
    // node:sqlite case makes the same argument for the same reason.
    const src = withoutComments(readFileSync(new URL("../../server/installer.mjs", import.meta.url), "utf8"));
    expect(src).not.toContain(".catch(() => ({ raw: before }))");
    // And both write paths must consult a re-read at all.
    expect((src.match(/unreadable = true/g) ?? []).length,
      "one of the two write paths lost its unreadable check").toBe(2);
  });
});
