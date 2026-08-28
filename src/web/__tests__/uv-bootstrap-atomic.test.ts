// Reported: bootstrapUv() copied the ~40MB uv binary straight to its final
// name, and every later call returned whatever sat at that name without ever
// running it. Kill the deck during that copy — first boot does the install
// before the SIGINT handlers exist — and the truncated file became permanent:
// the reuse shortcut handed it back as ok forever, claude-swap failed to
// install on every boot, and nothing but deleting ~/.agents-deck/tools/uv by
// hand fixed it. These tests pin both halves of the fix: the copy lands under a
// temp name and is renamed into place, and a uv that does not run is replaced
// rather than trusted.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const VERSION = "9.9.9";
// What the archive "contains". Extraction is mocked, so these bytes stand in
// for the real binary and are what has to end up at the final name intact.
const PAYLOAD = Buffer.from(`#!/fake/uv ${VERSION}\n${"x".repeat(4096)}`);
const ARCHIVE = Buffer.from("archive bytes; extraction is mocked");
const ARCHIVE_SHA = createHash("sha256").update(ARCHIVE).digest("hex");
const EXE = process.platform === "win32" ? "uv.exe" : "uv";

/**
 * Where bootstrapUv unpacked, read out of the extract command it issued.
 *
 * It used to be computable here — `join(tmpdir(), `agents-deck-uv-${pid}`)` —
 * and that predictability was half of #551: on Linux tmpdir() is world-writable
 * `/tmp`, so another account could pre-create the directory and plant the file
 * that gets executed. Staging is a mkdtemp under the user's own tools directory
 * now, so its name is not knowable in advance, and the honest way to find it is
 * the way the real tar would: it is in the arguments.
 */
function stagingFrom(cmd: string, args: string[]): string {
  if (cmd === "tar") return args[3];                        // -xzf <archive> -C <dest>
  const m = /-DestinationPath '((?:[^']|'')*)'/.exec(args[3] ?? "");
  if (!m) throw new Error(`test: no -DestinationPath in ${args[3]}`);
  return m[1].replace(/''/g, "'");
}
let staged: string | null = null;

// Nothing is spawned and nothing is fetched. `run` answers from a table — the
// copy under test is identified by its name, since the temp file is the only
// thing here starting with ".uv-" — and the extraction step writes the fake
// binary into the staging dir the way tar or Expand-Archive would.
const { existingRuns, copyRuns, spawned } = vi.hoisted(() => ({
  existingRuns: { is: true },
  copyRuns: { is: true },
  spawned: [] as string[],
}));

const ok = (stdout: string) => ({ ok: true, code: 0, killed: false, stdout, stderr: "" });
const fail = () => ({ ok: false, code: 1, killed: false, stdout: "", stderr: "not an executable" });

vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    // Stand-in for `tar -xzf` on POSIX and Expand-Archive on Windows.
    if (cmd === "tar" || cmd === "powershell.exe") {
      staged = stagingFrom(cmd, args);
      const inner = join(staged, `uv-${VERSION}-fake-target`);
      mkdirSync(inner, { recursive: true });
      writeFileSync(join(inner, EXE), PAYLOAD);
      return ok("");
    }
    if (args[0] !== "--version") return fail();
    spawned.push(cmd);
    // The temp file the copy just wrote, or the one already at the final name —
    // each test says which of the two is a working binary.
    if (basename(cmd).startsWith(".uv-")) return copyRuns.is ? ok(`uv ${VERSION}`) : fail();
    return existingRuns.is ? ok("uv 0.1.0") : fail();
  },
  runDetached: () => {},
}));

let fetches = 0;
vi.stubGlobal("fetch", async (url: string) => {
  fetches++;
  const u = String(url);
  if (u.includes("api.github.com")) return { ok: true, json: async () => ({ tag_name: VERSION }) };
  if (u.endsWith(".sha256")) return { ok: true, text: async () => `${ARCHIVE_SHA}  asset\n` };
  return { ok: true, arrayBuffer: async () => new Uint8Array(ARCHIVE).buffer };
});

// uv-bootstrap resolves ~/.agents-deck at import time via os.homedir(), which
// reads $HOME on POSIX and %USERPROFILE% on Windows. Both point at a temp
// directory BEFORE the module loads, so no test here can see, replace or delete
// the developer's own bootstrapped uv.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-uv-atomic-"));
const prev = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  NO_DOWNLOAD: process.env.AGENTS_DECK_NO_DOWNLOAD,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
delete process.env.AGENTS_DECK_NO_DOWNLOAD;

// @ts-expect-error — .mjs server module, no types
const { bootstrapUv, existingBootstrappedUv } = await import("../../server/uv-bootstrap.mjs");

const UV_DIR = join(FAKE_HOME, ".agents-deck", "tools", "uv");
const BIN = join(UV_DIR, EXE);

// Belt and braces. If homedir() ever stopped honouring the environment, these
// tests would be overwriting the developer's real uv — so fail before any of
// them gets the chance.
mkdirSync(UV_DIR, { recursive: true });
writeFileSync(BIN, "probe");
if (existingBootstrappedUv() !== BIN) {
  throw new Error(`refusing to run: uv-bootstrap resolved outside ${FAKE_HOME}`);
}
rmSync(BIN, { force: true });

// A hard link is the only portable way to ask "was this file replaced, or
// written in place?" — both names share one inode until a rename gives the
// visible name a new one.
const hardLinksWork = (() => {
  const probe = join(FAKE_HOME, "probe");
  const linked = join(FAKE_HOME, "probe.link");
  try {
    writeFileSync(probe, "x");
    linkSync(probe, linked);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { force: true });
    rmSync(linked, { force: true });
  }
})();

const strays = () => readdirSync(UV_DIR).filter(name => name !== EXE);

beforeEach(() => {
  rmTempDir(UV_DIR);
  mkdirSync(UV_DIR, { recursive: true });
  staged = null;
  existingRuns.is = true;
  copyRuns.is = true;
  spawned.length = 0;
  fetches = 0;
  delete process.env.AGENTS_DECK_NO_DOWNLOAD;
});

afterAll(() => {
  for (const [key, was] of [["HOME", prev.HOME], ["USERPROFILE", prev.USERPROFILE],
    ["AGENTS_DECK_NO_DOWNLOAD", prev.NO_DOWNLOAD]] as const) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  // Staging lives under FAKE_HOME now, so the one removal covers both.
  rmTempDir(FAKE_HOME);
});

describe("a uv left over from an earlier run", () => {
  it("is reused, without a download, while it still runs", async () => {
    writeFileSync(BIN, PAYLOAD);

    const res = await bootstrapUv();

    expect(res).toEqual({ ok: true, bin: BIN, version: "existing" });
    expect(spawned).toEqual([BIN]);
    expect(fetches).toBe(0);
  });

  it("is not handed back as ok when it no longer runs", async () => {
    // The wedge from the report: a torn binary at the final name. Downloads are
    // off, so the only two answers available are "here is your broken uv" — the
    // bug — and "no uv", which lets the caller report why and try again later.
    writeFileSync(BIN, "torn");
    existingRuns.is = false;
    process.env.AGENTS_DECK_NO_DOWNLOAD = "1";

    const res = await bootstrapUv();

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("download_disabled");
    expect(spawned).toEqual([BIN]);
    expect(fetches).toBe(0);
  });

  it("is replaced by a fresh download when it no longer runs", async () => {
    writeFileSync(BIN, "torn");
    existingRuns.is = false;

    const res = await bootstrapUv();

    expect(res).toMatchObject({ ok: true, bin: BIN, version: VERSION });
    expect(readFileSync(BIN)).toEqual(PAYLOAD);
    expect(strays()).toEqual([]);
  });
});

describe("the downloaded binary reaches its final name in one step", () => {
  it.skipIf(!hardLinksWork)("renames a complete copy into place instead of writing into the name", async () => {
    writeFileSync(BIN, "torn");
    existingRuns.is = false;
    // Second name for the torn file's inode. Whatever the bootstrap does to the
    // bytes of the existing file, this name sees it too.
    const witness = join(FAKE_HOME, "witness");
    rmSync(witness, { force: true });
    linkSync(BIN, witness);

    await bootstrapUv();

    // uv is the new binary and the old inode is untouched — only a rename over
    // the name can do that. A copy onto the final path would have shown every
    // intermediate state here, torn file included.
    expect(readFileSync(BIN)).toEqual(PAYLOAD);
    expect(readFileSync(witness, "utf8")).toBe("torn");
    rmSync(witness, { force: true });
  });

  it("verifies the copy before it becomes uv, and leaves nothing behind", async () => {
    // The binary that unpacked will not run: nothing may appear at the final
    // name, and the temp file must not survive the failure either.
    copyRuns.is = false;

    const res = await bootstrapUv();

    expect(res).toEqual({ ok: false, reason: "does_not_run" });
    expect(existsSync(BIN)).toBe(false);
    expect(readdirSync(UV_DIR)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("carries the executable bit through the rename", async () => {
    const res = await bootstrapUv();

    expect(res.ok).toBe(true);
    expect(statSync(BIN).mode & 0o111).toBe(0o111);
  });
});

describe("where the archive is unpacked", () => {
  // #551. The staging directory was `join(tmpdir(), `agents-deck-uv-${pid}`)`,
  // created with `mkdir(..., { recursive: true })` — which does not fail on a
  // directory that already exists.
  //
  // On macOS tmpdir() is a per-user /var/folders/…/T and on Windows it is inside
  // the profile, so the module header's promise that nothing lands outside a
  // directory the deck owns held on both. On Linux tmpdir() is /tmp, mode 1777,
  // writable by every account on the box.
  //
  // Three things then lined up: the name was derived from a pid and so cheap to
  // blanket in advance; findUv returns a depth-0 file before it recurses, while
  // the real uv sits one level down inside the archive's versioned directory, so
  // a planted file won deterministically rather than by racing; and the SHA-256
  // is computed on the downloaded buffer and never on the extracted file, so it
  // did not cover the thing that gets executed — copied, chmod 0755, run, and
  // renamed to the permanent name every later run trusts.

  it("is inside the user's own tools directory, not the system temp dir", async () => {
    const r = await bootstrapUv();
    expect(r).toMatchObject({ ok: true });
    expect(staged, "nothing recorded an extract command").toBeTruthy();
    expect(staged!.startsWith(join(FAKE_HOME, ".agents-deck", "tools"))).toBe(true);
    // Deliberately not `expect(staged).not.toStartWith(tmpdir())`: FAKE_HOME is
    // itself a mkdtemp under tmpdir, so that assertion is false here and would
    // be false for the wrong reason. What the fix is about is not the string
    // "tmp" — it is that the directory sits inside a tree this user owns and
    // that the deck created, rather than in the shared 1777 one every account on
    // a Linux box can write to. The assertion above is that property.
  });

  it("has a name nobody can work out in advance", async () => {
    // mkdtemp, not a pid. The old name was knowable to any local account that
    // could read /proc or simply try every plausible pid.
    await bootstrapUv();
    expect(staged).not.toContain(String(process.pid));
  });

  it("is gone afterwards, wherever it was", async () => {
    await bootstrapUv();
    expect(existsSync(staged!)).toBe(false);
  });
});
