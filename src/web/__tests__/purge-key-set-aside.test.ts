// `--purge` and the copies of prefs.json that sit beside it under other names.
//
// prefs.json is not the only file in the key folders that can hold the LAN
// private key. When the deck cannot use the file it moves it aside rather than
// overwriting it: bytes it could not parse go to `prefs.json.corrupt-<ms>` and a
// file another user owns to `prefs.json.foreign-<ms>` — and the deck tells the
// user that the key and the pairings are in the moved file. A write killed
// between its temp file and its rename leaves `prefs.json.agent-dag-<pid>-<n>.tmp`,
// and a migration killed mid-copy `prefs.json.<pid>.migrating`; the next boot
// sweeps those, but after an uninstall there is no next boot.
//
// findKeyFiles only ever looked at `prefs.json` itself, so `--purge` left every
// one of them on the disk, and the listing without `--purge`, which exists to
// say where the key still is, did not name them either.
//
// Both halves: the module, against a folder holding each kind, and the real CLI
// in a sandbox, which is where a user meets it.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — .mjs server module, no types
const { findKeyFiles, purgeKeyFiles } = await import("../../server/purge-key.mjs");

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-set-aside-"));
afterAll(() => rmTempDir(SANDBOX));

const SECRET = "SYNTHETIC-KEY-NOT-A-REAL-ONE";
const withKey = JSON.stringify({ lan: { enabled: true, secret: SECRET } }, null, 2) + "\n";
// Cut off mid-object: what a quarantined file looks like, and still holding
// the key in its bytes.
const truncated = withKey.slice(0, withKey.indexOf(SECRET) + SECRET.length + 2);

type Found = { path: string; holds: "key" | "no-key" | "unknown"; why: string };

let dir = "";
let n = 0;
beforeEach(() => {
  dir = join(SANDBOX, `case-${n++}`);
  mkdirSync(dir, { recursive: true });
});

describe("the files beside prefs.json", () => {
  it("lists a set-aside copy of each kind, as the key or as unreadable", async () => {
    const corrupt = join(dir, "prefs.json.corrupt-1790000000000");
    const foreign = join(dir, "prefs.json.foreign-1790000000001");
    writeFileSync(corrupt, truncated);
    writeFileSync(foreign, withKey);

    const found: Found[] = await findKeyFiles([dir]);

    expect(found.map(f => [f.path, f.holds])).toEqual([
      [corrupt, "unknown"],
      [foreign, "key"],
    ]);

    const { removed, failed } = await purgeKeyFiles(found);
    expect(failed).toEqual([]);
    expect(removed).toEqual([corrupt, foreign]);
    expect(existsSync(corrupt)).toBe(false);
    expect(existsSync(foreign)).toBe(false);
  });

  it("lists prefs.json first, then the rest, and the leftovers of a killed write", async () => {
    writeFileSync(join(dir, "prefs.json"), withKey);
    writeFileSync(join(dir, "prefs.json.agent-dag-4242-0.tmp"), withKey);
    writeFileSync(join(dir, "prefs.json.4242.migrating"), truncated);

    const found: Found[] = await findKeyFiles([dir]);

    expect(found.map(f => [f.path, f.holds])).toEqual([
      [join(dir, "prefs.json"), "key"],
      [join(dir, "prefs.json.4242.migrating"), "unknown"],
      [join(dir, "prefs.json.agent-dag-4242-0.tmp"), "key"],
    ]);
  });

  it("leaves every other file in the folder alone", async () => {
    // The key folder is also the discovery folder on a machine with
    // CLAUDE_CONFIG_DIR set: the forwarder, the deck records and the user's
    // own notes can all be in it. Only names the deck makes from prefs.json
    // are its to list.
    for (const name of ["hook.js", "4242.json", "prefs.json.mine", "prefs.json.corrupt-", "prefs.jsonx.corrupt-1", "old-prefs.json"]) {
      writeFileSync(join(dir, name), withKey);
    }

    expect(await findKeyFiles([dir])).toEqual([]);
  });

  it("finds nothing in a folder that is not there", async () => {
    expect(await findKeyFiles([join(dir, "missing")])).toEqual([]);
  });
});

describe("`--uninstall` on a machine with set-aside copies", () => {
  const HOME = join(SANDBOX, "home");
  const CFG = join(HOME, ".claude");
  const DATA = join(HOME, "deck-data");
  const ENV = {
    ...process.env,
    HOME, USERPROFILE: HOME,
    CLAUDE_CONFIG_DIR: CFG,
    CODEX_HOME: join(HOME, ".codex"),
    CCDECK_HOME: DATA,
    XDG_CONFIG_HOME: join(HOME, "xdg-config"),
    XDG_DATA_HOME: join(HOME, "xdg-data"),
    XDG_STATE_HOME: join(HOME, "xdg-state"),
    AGENTS_DECK_NO_LAN: "1",
    NO_COLOR: "1",
  };
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CCDECK_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const) {
    if (!resolve(String(ENV[k])).startsWith(resolve(SANDBOX))) throw new Error(`sandbox escaped: ${k}`);
  }
  const DECK = fileURLToPath(new URL("../../../bin/deck.js", import.meta.url));
  const run = (args: string[]) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [DECK, ...args], { env: ENV, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };

  it("names them without --purge and removes them with it, never printing the key", () => {
    mkdirSync(DATA, { recursive: true });
    mkdirSync(CFG, { recursive: true });
    const corrupt = join(DATA, "prefs.json.corrupt-1790000000000");
    const foreign = join(DATA, "prefs.json.foreign-1790000000001");
    writeFileSync(corrupt, truncated);
    writeFileSync(foreign, withKey);

    const listed = run(["--uninstall"]);
    expect(listed.code, listed.out).toBe(0);
    expect(listed.out).toContain(corrupt);
    expect(listed.out).toContain(foreign);
    expect(existsSync(corrupt) && existsSync(foreign)).toBe(true);

    const purged = run(["--uninstall", "--purge"]);
    expect(purged.code, purged.out).toBe(0);
    expect(purged.out).toContain(`removed ${corrupt}`);
    expect(purged.out).toContain(`removed ${foreign}`);
    expect(purged.out).not.toContain("no ccdeck state to purge");
    expect(existsSync(corrupt)).toBe(false);
    expect(existsSync(foreign)).toBe(false);

    for (const out of [listed.out, purged.out]) expect(out).not.toContain(SECRET);
  }, 90_000);
});
