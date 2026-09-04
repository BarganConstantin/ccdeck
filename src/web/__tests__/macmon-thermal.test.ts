// Degrees on Apple Silicon, from a tool the user already has (#747).
//
// There is no command shipped with macOS that prints a CPU or GPU temperature
// on an M-series Mac. `powermetrics` needs root. `pmset -g therm` records
// nothing there and answers "No CPU power status has been recorded", which is
// why the throttle row is missing too. The AGX driver does not publish the
// `"Temperature(C)"` that ioreg reads on Intel GPUs. The SMC keys changed with
// M1 and are inconsistent between models sharing one chip — an M1 Mac mini uses
// different FourCCs from an M1 MacBook Pro — so there is nothing to hard-code.
//
// The sensors ARE reachable without root, through a HID sensor hub, which is a
// private C API. Every tool that reads them is native code, and this package
// has zero runtime dependencies. So the deck asks a tool the user installed,
// the same way it already asks `cswap` about accounts and `ccusage` about
// spend. `macmon` is in homebrew-core, runs without sudo, covers M1 through M5,
// and prints JSON.
//
// Written on an Intel Mac, which is the machine that can never reach this code
// — ioreg answers there. So the reader is driven against a real fake binary on
// disk, and the ordering rule is a pure function.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error — plain .mjs modules, no types
const {
  tempsFromMacmonJson, readMacmonTemps, macmonBin, resetMacmonBin, MACMON_ARGS,
  macmonAsset, bootstrapMacmon, resetMacmonFetch, MACMON_CANDIDATES,
} = await import("../../server/macmon.mjs");
// @ts-expect-error — ditto
const { darwinThermal } = await import("../../server/system-metrics.mjs");

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-macmon-"));
afterAll(() => { rmTempDir(DIR); });
beforeEach(() => { resetMacmonBin(); resetMacmonFetch(); });

/** A macmon that is really on disk and really runs, so the spawn, the argv and
 *  the parse are all exercised rather than described.
 *
 *  Written in the runner's own shell rather than in `sh`, because the CI matrix
 *  includes Windows and a `#!/bin/sh` file there is a text file: it has no
 *  shebang support and no /bin/sh to honour one. The module under test is
 *  macOS-only, but a test that quietly passed by not running is worse than one
 *  that runs everywhere. `run` sends a `.cmd` through cmd.exe already — see
 *  exec.mjs — so the caller needs to know nothing about this. */
const WIN = process.platform === "win32";

function fakeMacmon(name: string, lines: string[]): string {
  const p = join(DIR, WIN ? `${name}.cmd` : name);
  writeFileSync(p, WIN
    ? `@echo off\r\n${lines.map(l => `echo ${l}`).join("\r\n")}\r\n`
    : `#!/bin/sh\n${lines.map(l => `echo '${l}'`).join("\n")}\n`);
  if (!WIN) chmodSync(p, 0o755);
  return p;
}

/** The one fake that fails instead of printing. Its own helper, because "exit
 *  with a code" is spelled differently on the two shells and threading that
 *  through the line list above would be cleverer than it is clear. */
function failingMacmon(name: string): string {
  const p = join(DIR, WIN ? `${name}.cmd` : name);
  writeFileSync(p, WIN ? "@echo off\r\nexit /b 3\r\n" : "#!/bin/sh\nexit 3\n");
  if (!WIN) chmodSync(p, 0o755);
  return p;
}

describe("reading one sample", () => {
  it("takes the two fields macmon's own struct declares", () => {
    // Read off TempMetrics upstream rather than guessed from an example: a
    // field renamed there should read as "no sensor", never as zero.
    expect(tempsFromMacmonJson('{"temp":{"cpu_temp_avg":47.3,"gpu_temp_avg":36.2}}'))
      .toEqual({ cpu: 47, gpu: 36 });
  });

  it("drops a zero, which is the absence of a reading wearing a number", () => {
    // macmon defaults both fields to 0.0 and fills what it read, so a machine
    // that answered for the CPU and not the GPU arrives exactly like this.
    expect(tempsFromMacmonJson('{"temp":{"cpu_temp_avg":47.3,"gpu_temp_avg":0}}'))
      .toEqual({ cpu: 47 });
    expect(tempsFromMacmonJson('{"temp":{"cpu_temp_avg":0,"gpu_temp_avg":0}}')).toEqual({});
  });

  it("answers nothing for every shape that is not a sample", () => {
    for (const junk of ['{"temp":{"cpu":47}}', "{}", "null", "[]", "not json", "", undefined]) {
      expect(tempsFromMacmonJson(junk as string)).toEqual({});
    }
  });

  it("refuses a number no sensor produces", () => {
    for (const v of [-5, 0, 150, 1e9]) {
      expect(tempsFromMacmonJson(JSON.stringify({ temp: { cpu_temp_avg: v } }))).toEqual({});
    }
  });
});

describe("asking the binary", () => {
  it("asks for one sample and a short window", async () => {
    // `-i` is the sampling window and its default is a full second. A poll
    // every ten seconds must not cost one.
    expect(MACMON_ARGS).toEqual(["pipe", "-s", "1", "-i", "200"]);
  });

  it("runs it and reads what it printed", async () => {
    const bin = fakeMacmon("macmon-ok", ['{"temp":{"cpu_temp_avg":51.8,"gpu_temp_avg":44.1}}']);
    expect(await readMacmonTemps({ candidates: [bin], exists: (p: string) => p === bin, probe: async (b: string) => b === bin }))
      .toEqual({ cpu: 52, gpu: 44 });
  });

  it("finds the JSON even if something spoke first", async () => {
    const bin = fakeMacmon("macmon-noisy", ["warming up", '{"temp":{"cpu_temp_avg":40}}']);
    expect(await readMacmonTemps({ candidates: [bin], exists: (p: string) => p === bin, probe: async (b: string) => b === bin }))
      .toEqual({ cpu: 40 });
  });

  it("answers nothing when the binary fails rather than letting it throw", async () => {
    const bin = failingMacmon("macmon-bad");
    expect(await readMacmonTemps({ candidates: [bin], exists: (p: string) => p === bin, probe: async (b: string) => b === bin }))
      .toEqual({});
  });

  it("spawns nothing at all on a machine that has no macmon", async () => {
    let probes = 0;
    const deps = { candidates: [], exists: () => false, probe: async () => { probes++; return false; } };
    expect(await readMacmonTemps(deps)).toEqual({});
    const afterFirst = probes;
    // And not again. A "looked, not there" answer is remembered, or every
    // Apple Silicon Mac without macmon pays a lookup every ten seconds forever.
    expect(await readMacmonTemps(deps)).toEqual({});
    expect(probes).toBe(afterFirst);
    expect(await macmonBin(deps)).toBeNull();
  });

  it("remembers the one it found, too", async () => {
    const bin = fakeMacmon("macmon-memo", ['{"temp":{"cpu_temp_avg":33}}']);
    let probes = 0;
    const deps = {
      candidates: [bin],
      exists: (p: string) => p === bin,
      probe: async (b: string) => { probes++; return b === bin; },
    };
    expect(await macmonBin(deps)).toBe(bin);
    const afterFirst = probes;
    expect(await macmonBin(deps)).toBe(bin);
    expect(probes).toBe(afterFirst);
  });
});

describe("which source wins on macOS", () => {
  it("keeps ioreg and pmset when macOS answered, and never shows macmon's numbers over them", () => {
    // The Intel path, unchanged. These are the same numbers this deck has
    // always shown and they cost one cheap subprocess each.
    expect(darwinThermal({ gpuC: 59, throttle: { speedLimit: 100 }, macmon: { cpu: 99, gpu: 99 } }))
      .toEqual({
        celsius: [{ label: "GPU", celsius: 59, warnAt: 75, critAt: 90 }],
        throttle: { speedLimit: 100 },
      });
  });

  it("uses macmon only when both were silent, CPU first", () => {
    // On the machine that reaches here the CPU is the reading somebody opened
    // the panel for, and the panel draws rows in the order given.
    expect(darwinThermal({ macmon: { cpu: 47, gpu: 36 } })).toEqual({
      celsius: [
        { label: "CPU", celsius: 47, warnAt: 75, critAt: 90 },
        { label: "GPU", celsius: 36, warnAt: 75, critAt: 90 },
      ],
      throttle: null,
    });
  });

  it("renders no section at all when nothing answered", () => {
    // An Apple Silicon Mac without macmon, which is the default. Not 0 °C, not
    // a dash, not an empty bar — the rule the whole module is built on.
    expect(darwinThermal({})).toBeNull();
    expect(darwinThermal({ macmon: {} })).toBeNull();
  });

  it("still shows a throttle row on its own, with no degrees anywhere", () => {
    // An Intel Mac whose GPU key is missing but whose pmset answers.
    expect(darwinThermal({ throttle: { speedLimit: 70 } }))
      .toEqual({ celsius: [], throttle: { speedLimit: 70 } });
  });
});

// ── fetching it, so the user does not have to ────────────────────────────────
//
// `npx ccdeck` should work, and on Apple Silicon "work" includes these rows.
// Telling somebody to run a brew command first is a step, and a step is a thing
// most people will not take. So the deck fetches macmon the way it already
// fetches uv — not through Homebrew, which a machine may not have and which is
// a very large thing to install on somebody's behalf.
//
// Every fact the download rests on was checked against the real release rather
// than assumed, and the checks are recorded here because they are what makes
// running a downloaded binary on someone's machine defensible:
//
//   * a prebuilt `Mach-O 64-bit executable arm64` in a 746 KB tarball
//   * `adhoc, linker-signed`, which is what Apple Silicon requires to exec
//   * no com.apple.quarantine on a programmatic download, so no Gatekeeper
//   * a sha256 that matched the bytes, taken from the releases API's `digest`

describe("choosing what to download", () => {
  /** The shape the GitHub releases API really returned for v0.8.2, trimmed. */
  const REAL = {
    tag_name: "v0.8.2",
    assets: [{
      name: "macmon-v0.8.2.tar.gz",
      browser_download_url: "https://github.com/vladkens/macmon/releases/download/v0.8.2/macmon-v0.8.2.tar.gz",
      digest: "sha256:588d5bde79885ba36f693e5150911c10c3ad208a2e418a3f2aa827ac84a2d973",
      size: 746669,
    }],
  };

  it("takes the tarball and its digest", () => {
    // That hex is the sha256 of the bytes actually downloaded while writing
    // this, not a value copied off a page.
    expect(macmonAsset(REAL)).toEqual({
      version: "v0.8.2",
      url: REAL.assets[0].browser_download_url,
      sha256: "588d5bde79885ba36f693e5150911c10c3ad208a2e418a3f2aa827ac84a2d973",
    });
  });

  it("refuses an asset with no digest, rather than downloading it anyway", () => {
    // The release publishes no .sha256 file; the API's `digest` field is the
    // only checksum there is. Without one there is no way to know what was
    // downloaded, and an unverified binary is not something to run on
    // somebody's machine — uv-bootstrap's rule, kept.
    expect(macmonAsset({ tag_name: "v1", assets: [{ name: "a.tar.gz", browser_download_url: "u" }] })).toBeNull();
    expect(macmonAsset({ tag_name: "v1", assets: [{ name: "a.tar.gz", browser_download_url: "u", digest: "md5:abc" }] })).toBeNull();
  });

  it("refuses a release with nothing to take", () => {
    for (const r of [null, {}, { assets: [] }, { assets: [{ name: "notes.txt", digest: "sha256:" + "a".repeat(64) }] }]) {
      expect(macmonAsset(r as never)).toBeNull();
    }
  });

  it("prefers the copy the deck manages over a brew one", () => {
    // A machine with both uses the one whose version this code was written
    // against, rather than whichever brew happens to hold.
    expect(MACMON_CANDIDATES[0]).toContain(".agents-deck");
    expect(MACMON_CANDIDATES.slice(1)).toEqual(["/opt/homebrew/bin/macmon", "/usr/local/bin/macmon"]);
  });
});

describe("when the download is not attempted at all", () => {
  const never = () => { throw new Error("must not reach the network"); };

  it("is never attempted off macOS", async () => {
    // The only build published is arm64 Mach-O. There is nothing to fetch for
    // a Linux or Windows deck and no reason to ask.
    for (const platform of ["linux", "win32", "sunos"]) {
      expect(await bootstrapMacmon({ platform, env: {}, fetchFn: never as never }))
        .toEqual({ ok: false, reason: "unsupported_platform" });
    }
  });

  it("honours both off switches", async () => {
    // Downloading an executable is a bigger step than installing a package
    // with a tool the user already chose, so it has its own switch as well as
    // the blanket one — somebody may want the managed installs and not this.
    expect(await bootstrapMacmon({ platform: "darwin", env: { AGENTS_DECK_NO_INSTALL: "1" }, fetchFn: never as never }))
      .toEqual({ ok: false, reason: "installs_disabled" });
    resetMacmonFetch();
    expect(await bootstrapMacmon({ platform: "darwin", env: { AGENTS_DECK_NO_DOWNLOAD: "1" }, fetchFn: never as never }))
      .toEqual({ ok: false, reason: "download_disabled" });
  });

  it("tries once per process, however often it is asked", async () => {
    // A machine that is offline, or behind a proxy that refuses GitHub, must
    // not re-download every ten seconds for as long as the deck runs.
    let calls = 0;
    const fetchFn = async () => { calls++; return { ok: false } as never; };
    expect(await bootstrapMacmon({ platform: "darwin", env: {}, fetchFn }))
      .toEqual({ ok: false, reason: "release_lookup_failed" });
    expect(await bootstrapMacmon({ platform: "darwin", env: {}, fetchFn }))
      .toEqual({ ok: false, reason: "already_tried" });
    expect(calls).toBe(1);
  });
});

describe("what the download refuses to install", () => {
  const release = (digest: string) => ({
    ok: true,
    json: async () => ({
      tag_name: "v9.9.9",
      assets: [{ name: "macmon-v9.9.9.tar.gz", browser_download_url: "https://example.invalid/m.tar.gz", digest }],
    }),
  });

  it("bytes that do not match the digest", async () => {
    // The whole point of checking: what arrived is not what the release says
    // it published, and the difference could be anything.
    const fetchFn = async (url: string) => (String(url).includes("api.github.com")
      ? release("sha256:" + "b".repeat(64))
      : { ok: true, arrayBuffer: async () => new TextEncoder().encode("not the release").buffer }) as never;
    expect(await bootstrapMacmon({ platform: "darwin", env: {}, fetchFn }))
      .toEqual({ ok: false, reason: "checksum_mismatch" });
  });

  it("a download that failed, without pretending it succeeded", async () => {
    const fetchFn = async (url: string) => (String(url).includes("api.github.com")
      ? release("sha256:" + "c".repeat(64))
      : { ok: false }) as never;
    expect(await bootstrapMacmon({ platform: "darwin", env: {}, fetchFn }))
      .toEqual({ ok: false, reason: "download_failed" });
  });

  it("a release whose asset it cannot verify", async () => {
    const fetchFn = async () => ({
      ok: true,
      json: async () => ({ tag_name: "v1", assets: [{ name: "m.tar.gz", browser_download_url: "u" }] }),
    }) as never;
    expect(await bootstrapMacmon({ platform: "darwin", env: {}, fetchFn }))
      .toEqual({ ok: false, reason: "no_verifiable_asset" });
  });

  it("never throws, whatever the network does", async () => {
    const fetchFn = async () => { throw new Error("ENETDOWN"); };
    const r = await bootstrapMacmon({ platform: "darwin", env: {}, fetchFn: fetchFn as never });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("error");
  });
});

describe("the whole download, run for real", () => {
  // A tarball built here rather than the release's, so the case can run on any
  // machine in the matrix — the published binary is arm64 Mach-O and this suite
  // also runs on Intel, Linux and Windows. What is exercised is everything
  // around the bytes: the digest check, the extract, the copy, the chmod, the
  // fsync, the `--version` gate and the atomic rename.
  const WIN_SKIP = process.platform === "win32";

  function tarballOf(script: string): { path: string; sha256: string } {
    const src = mkdtempSync(join(DIR, "src-"));
    const bin = join(src, "macmon");
    writeFileSync(bin, script);
    chmodSync(bin, 0o755);
    writeFileSync(join(src, "readme.md"), "# fake\n");
    const tgz = join(DIR, `pkg-${Math.random().toString(36).slice(2)}.tar.gz`);
    execFileSync("tar", ["-czf", tgz, "-C", src, "macmon", "readme.md"]);
    const bytes = readFileSync(tgz);
    return { path: tgz, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  const serve = (tgz: { path: string; sha256: string }) => async (url: string) => (
    String(url).includes("api.github.com")
      ? {
          ok: true,
          json: async () => ({
            tag_name: "v9.9.9",
            assets: [{
              name: "macmon-v9.9.9.tar.gz",
              browser_download_url: "https://example.invalid/macmon-v9.9.9.tar.gz",
              digest: `sha256:${tgz.sha256}`,
            }],
          }),
        }
      // Sliced to the file's own bytes. A Node Buffer under 8 KB comes out of a
      // shared pool, so `.buffer` is the whole pool and `Buffer.from` of it is
      // megabytes of other people's data — which fails the digest check, for the
      // right reason, on a file that was perfectly fine.
      : { ok: true, arrayBuffer: async () => {
          const b = readFileSync(tgz.path);
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        } }
  ) as never;

  it("installs a verified binary and reads a temperature through it", async () => {
    if (WIN_SKIP) {
      // The published build is arm64 Mach-O and `tar -czf` of a shell script is
      // not something a Windows deck would ever install. The refusal above —
      // "never attempted off macOS" — is what covers Windows, and it runs.
      expect(await bootstrapMacmon({ platform: "win32", env: {} })).toEqual({ ok: false, reason: "unsupported_platform" });
      return;
    }
    const tgz = tarballOf(`#!/bin/sh\n[ "$1" = "--version" ] && { echo "macmon 9.9.9"; exit 0; }\necho '{"temp":{"cpu_temp_avg":58.4,"gpu_temp_avg":41.9}}'\n`);
    const dest = mkdtempSync(join(DIR, "installed-"));

    const r = await bootstrapMacmon({ platform: "darwin", env: {}, fetchFn: serve(tgz), dir: dest });
    expect(r).toMatchObject({ ok: true, version: "v9.9.9" });
    expect(existsSync(join(dest, "macmon"))).toBe(true);

    // And the deck can now read through the thing it just installed. That is
    // the claim the whole file is for: `npx ccdeck` and nothing else.
    resetMacmonBin();
    expect(await readMacmonTemps({ candidates: [join(dest, "macmon")], exists: existsSync }))
      .toEqual({ cpu: 58, gpu: 42 });
  }, 40_000);

  it("leaves nothing behind when the binary will not run", async () => {
    if (WIN_SKIP) return;
    // The last gate. A build that cannot execute here must not be left under
    // the name every later boot trusts — uv-bootstrap learned that from a
    // truncated copy nothing ever re-checked.
    const tgz = tarballOf("#!/bin/sh\nexit 1\n");
    const dest = mkdtempSync(join(DIR, "broken-"));
    expect(await bootstrapMacmon({ platform: "darwin", env: {}, fetchFn: serve(tgz), dir: dest }))
      .toEqual({ ok: false, reason: "does_not_run" });
    expect(existsSync(join(dest, "macmon"))).toBe(false);
  }, 40_000);

  it("says so when the archive holds no macmon", async () => {
    if (WIN_SKIP) return;
    const src = mkdtempSync(join(DIR, "empty-"));
    writeFileSync(join(src, "readme.md"), "# nothing here\n");
    const tgz = join(DIR, `empty-${Math.random().toString(36).slice(2)}.tar.gz`);
    execFileSync("tar", ["-czf", tgz, "-C", src, "readme.md"]);
    const bytes = readFileSync(tgz);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const dest = mkdtempSync(join(DIR, "none-"));
    expect(await bootstrapMacmon({
      platform: "darwin", env: {}, dir: dest,
      fetchFn: serve({ path: tgz, sha256: sha }),
    })).toEqual({ ok: false, reason: "not_in_archive" });
  }, 40_000);
});
