// ccdeck's own tmux: what the deck fetches, what it refuses, and where it
// lands. Nothing is downloaded and nothing is run: `fetchImpl` hands back the
// bytes, and `execImpl` plays tar (writing a "binary" into the staging folder
// named in its arguments) and the binary's `-V`.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
import * as dl from "../../server/tmux-download.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-tmux-dl-"));
afterAll(() => rmTempDir(DIR));
afterEach(() => dl.resetTmuxDownload());

const ARCHIVE = Buffer.from("tmux build archive; extraction is played by execImpl");
const SHA = createHash("sha256").update(ARCHIVE).digest("hex");
/** A build whose linux-x64 hash is the archive's. */
const BUILD = Object.freeze({
  tag: "tmux-3.8-1", version: "3.8",
  sha256: { "linux-x64": SHA, "linux-arm64": "", "darwin-x64": "", "darwin-arm64": "" },
});
const LINUX = { env: {}, platform: "linux", arch: "x64", build: BUILD };

let n = 0;
const freshDir = () => join(DIR, `data-${++n}`);

/** A fetch answering `body`, recording what was asked. */
function fetching(body: Buffer, { status = 200, length }: { status?: number; length?: number } = {}) {
  const asked: string[] = [];
  const impl = async (url: string) => {
    asked.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h: string) => (h === "content-length" ? String(length ?? body.length) : null) },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
  return { asked, impl };
}

/** tar that unpacks a tmux answering `version` to -V (or nothing at all). */
function running(version: string | null, { unpack = true } = {}) {
  const ran: string[][] = [];
  const impl = async (file: string, args: string[]) => {
    ran.push([file, ...args]);
    if (file === "tar") {
      if (unpack) writeFileSync(join(args[3], "tmux"), "#!/fake/tmux\n");
      return { code: 0, stdout: "" };
    }
    return version === null ? { code: 1, stdout: "" } : { code: 0, stdout: `tmux ${version}\n` };
  };
  return { ran, impl };
}

const leftovers = (dataDir: string) => {
  const parent = join(dataDir, "tools", "tmux");
  return existsSync(parent) ? readdirSync(parent).filter(f => f.startsWith(".staging-")) : [];
};

describe("which build, and where", () => {
  it("names a build for Linux and macOS on x64 and arm64, and none elsewhere", () => {
    expect(dl.tmuxBuildKey("linux", "x64")).toBe("linux-x64");
    expect(dl.tmuxBuildKey("linux", "arm64")).toBe("linux-arm64");
    expect(dl.tmuxBuildKey("darwin", "x64")).toBe("darwin-x64");
    expect(dl.tmuxBuildKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(dl.tmuxBuildKey("win32", "x64")).toBeNull();
    expect(dl.tmuxBuildKey("linux", "ia32")).toBeNull();
    expect(dl.tmuxBuildKey("freebsd", "x64")).toBeNull();
  });

  it("keeps each build in its own folder under the deck's tools", () => {
    expect(dl.managedTmuxPath("/data", BUILD)).toBe(join("/data", "tools", "tmux", "tmux-3.8-1", "tmux"));
  });

  it("asks for the archive build.sh writes, under the tag in the deck's source", () => {
    const recipe = readFileSync(join(ROOT, "scripts/tmux/build.sh"), "utf8");
    const version = /^TMUX_VERSION=(\S+)$/m.exec(recipe)?.[1];
    expect(dl.TMUX_BUILD.version, "the deck fetches the version the recipe builds").toBe(version);
    expect(dl.TMUX_BUILD.tag).toMatch(new RegExp(`^tmux-${version!.replace(/\./g, "\\.")}-\\d+$`));
    // build.sh: NAME=tmux-$TMUX_VERSION-$OS-$ARCH_NAME, with ARCH_NAME x64 or arm64.
    expect(dl.tmuxAssetName("darwin-arm64")).toBe(`tmux-${version}-darwin-arm64.tar.gz`);
    expect(recipe).toContain("NAME=tmux-$TMUX_VERSION-$OS-$ARCH_NAME");
  });

  it("pins a SHA-256 for every build it names, or none at all before the first release", () => {
    const hashes = Object.values(dl.TMUX_BUILD.sha256) as string[];
    expect(Object.keys(dl.TMUX_BUILD.sha256).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
    const pinned = hashes.filter(h => /^[0-9a-f]{64}$/.test(h));
    expect(pinned.length === 0 || pinned.length === 4, "half a release is no release").toBe(true);
    expect(hashes.every(h => h === "" || /^[0-9a-f]{64}$/.test(h))).toBe(true);
  });
});

describe("when the deck will not fetch it", () => {
  it("says why: switched off, no build for this machine, or none published", () => {
    expect(dl.tmuxDownloadBlocked({ ...LINUX, env: { AGENTS_DECK_NO_INSTALL: "1" } })).toBe("install_disabled");
    expect(dl.tmuxDownloadBlocked({ ...LINUX, env: { AGENTS_DECK_NO_DOWNLOAD: "1" } })).toBe("download_disabled");
    expect(dl.tmuxDownloadBlocked({ ...LINUX, platform: "win32" })).toBe("unsupported_platform");
    expect(dl.tmuxDownloadBlocked({ ...LINUX, arch: "arm64" }), "an empty hash is not a build").toBe("not_published");
    expect(dl.tmuxDownloadBlocked(LINUX)).toBeNull();
  });

  it("asks nothing of the network when blocked", async () => {
    const f = fetching(ARCHIVE);
    const got = await dl.downloadTmux({ ...LINUX, env: { AGENTS_DECK_NO_DOWNLOAD: "1" }, dataDir: freshDir(), fetchImpl: f.impl });
    expect(got).toEqual({ ok: false, reason: "download_disabled" });
    expect(f.asked).toEqual([]);
  });
});

describe("fetching it", () => {
  it("fetches this machine's archive from the tag, checks it, runs it, and only then puts it in place", async () => {
    const dataDir = freshDir();
    const f = fetching(ARCHIVE);
    const x = running("3.8");
    const got = await dl.downloadTmux({ ...LINUX, dataDir, fetchImpl: f.impl, execImpl: x.impl });
    const path = dl.managedTmuxPath(dataDir, BUILD);
    expect(got).toEqual({ ok: true, path });
    expect(f.asked).toEqual(["https://github.com/BarganConstantin/ccdeck/releases/download/tmux-3.8-1/tmux-3.8-linux-x64.tar.gz"]);
    expect(existsSync(path)).toBe(true);
    expect(x.ran.map(r => r[0])).toEqual(["tar", expect.stringContaining(".staging-")]);
    expect(x.ran[1][1], "run from staging, before it is moved").toBe("-V");
    expect(dirname(x.ran[0][4]), "staged inside the tools folder, not in /tmp").toBe(join(dataDir, "tools", "tmux"));
    expect(leftovers(dataDir)).toEqual([]);
  });

  it("never unpacks or runs an archive whose hash is not the pinned one", async () => {
    const dataDir = freshDir();
    const x = running("3.8");
    const got = await dl.downloadTmux({ ...LINUX, dataDir, fetchImpl: fetching(Buffer.from("swapped")).impl, execImpl: x.impl });
    expect(got).toEqual({ ok: false, reason: "checksum_mismatch" });
    expect(x.ran).toEqual([]);
    expect(existsSync(dl.managedTmuxDir(dataDir, BUILD))).toBe(false);
  });

  it("refuses an answer that says it is far bigger than a build, before reading it", async () => {
    const got = await dl.downloadTmux({ ...LINUX, dataDir: freshDir(), fetchImpl: fetching(ARCHIVE, { length: 64 << 20 }).impl });
    expect(got).toEqual({ ok: false, reason: "too_large" });
  });

  it("says download_failed for a refusal or no answer at all", async () => {
    expect(await dl.downloadTmux({ ...LINUX, dataDir: freshDir(), fetchImpl: fetching(ARCHIVE, { status: 404 }).impl }))
      .toEqual({ ok: false, reason: "download_failed" });
    const offline = async () => { throw new TypeError("fetch failed"); };
    expect(await dl.downloadTmux({ ...LINUX, dataDir: freshDir(), fetchImpl: offline }))
      .toEqual({ ok: false, reason: "download_failed" });
  });

  it("puts nothing in place when the binary does not run or is not the version expected", async () => {
    for (const [version, unpack, reason] of [
      [null, true, "does_not_run"], ["3.6", true, "does_not_run"], ["3.8", false, "extract_failed"],
    ] as const) {
      const dataDir = freshDir();
      const got = await dl.downloadTmux({ ...LINUX, dataDir, fetchImpl: fetching(ARCHIVE).impl, execImpl: running(version, { unpack }).impl });
      expect(got).toEqual({ ok: false, reason });
      expect(existsSync(dl.managedTmuxDir(dataDir, BUILD))).toBe(false);
      expect(leftovers(dataDir), "the staging folder goes too").toEqual([]);
    }
  });
});

describe("one download at a time", () => {
  it("shares one download among everyone who asks while it is out", async () => {
    const f = fetching(ARCHIVE);
    const options = { ...LINUX, dataDir: freshDir(), fetchImpl: f.impl, execImpl: running("3.8").impl };
    const a = dl.ensureManagedTmux(options);
    const b = dl.ensureManagedTmux(options);
    expect(dl.tmuxDownloading()).toBe(true);
    expect(await a).toEqual(await b);
    expect(f.asked).toHaveLength(1);
    expect(dl.tmuxDownloading()).toBe(false);
  });

  it("believes a failure for a while, then lets the next ask try again", async () => {
    let t = 1_000_000;
    const now = () => t;
    await dl.ensureManagedTmux({ ...LINUX, dataDir: freshDir(), fetchImpl: fetching(ARCHIVE, { status: 503 }).impl }, now);
    expect(dl.recentTmuxFailure(now)).toEqual({ reason: "download_failed", at: 1_000_000 });
    t += dl.RETRY_AFTER_MS - 1;
    expect(dl.recentTmuxFailure(now)).not.toBeNull();
    t += 1;
    expect(dl.recentTmuxFailure(now)).toBeNull();
  });

  it("forgets an old failure once a download works", async () => {
    await dl.ensureManagedTmux({ ...LINUX, dataDir: freshDir(), fetchImpl: fetching(ARCHIVE, { status: 503 }).impl });
    expect(dl.recentTmuxFailure()).not.toBeNull();
    await dl.ensureManagedTmux({ ...LINUX, dataDir: freshDir(), fetchImpl: fetching(ARCHIVE).impl, execImpl: running("3.8").impl });
    expect(dl.recentTmuxFailure()).toBeNull();
  });
});
