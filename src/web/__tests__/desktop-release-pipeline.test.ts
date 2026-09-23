// The desktop app's release job (#1160, #1176): what CI has to do for an app
// that is already installed to be able to take the release it builds.
//
// Every other job in publish.yml is pinned line by line; these two were not,
// and each of the edits below ships a release no installed app can take while
// the build and the suite stay green:
//
//   · "Sign the updates" deleted or re-conditioned. The ymls carry no
//     `ed25519`, so every Windows and Linux app refuses every update, and
//     latest-mac.json is never written, so every Mac reads "manifest 404"
//     forever.
//   · artifactName changed so the signing loop's `${arch##*-mac-}` reads
//     `ccdeck-arm64` instead of `arm64`. pickFile then finds no file, and the
//     tray says "Up to date" to a Mac that is stuck.
//   · `-c.extraMetadata.version` dropped. The app reports desktop/package.json's
//     version, which nothing keeps in step, and may download the same release
//     again on every check.
//   · the certificate files never written on a tag. The app ships ad-hoc
//     signed, its designated requirement is its own hash, and check 4 refuses
//     every update after it.
//
// Read as text, like every other assertion this repo makes about CI, and
// sliced to the two jobs so nothing another job says can satisfy them. Where
// the workflow and the code have to agree — the Mac zip's name and the CPU the
// app compares, the manifest's name, the feed's repository — the code is run,
// not read, and the workflow's own words are what it is run against.
import { describe, it, expect, vi, afterEach } from "vitest";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs, no types
import { createUpdater, FEED } from "../../../desktop/updater.mjs";
// @ts-expect-error — plain .mjs, no types
import { pickFile } from "../../../desktop/updater-mac.mjs";

const require = createRequire(import.meta.url);
const config = require("../../../desktop/electron-builder.config.cjs");
const signMac = require("../../../desktop/scripts/sign-mac.cjs");
const { requirementFor, requirementForLeaf } = signMac;

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const publishYml = () => readFileSync(join(repo, ".github", "workflows", "publish.yml"), "utf8");

/** One job, from its key to the next job's: the jobs are the only two-space
 *  keys in the file, and everything inside one is indented deeper. */
const job = (id: string): string => {
  const yml = publishYml();
  const at = yml.indexOf(`\n  ${id}:\n`);
  expect(at, `publish.yml no longer has a \`${id}:\` job`).toBeGreaterThan(-1);
  const rest = yml.slice(at + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

type Step = { name: string; body: string };

/** A job's steps, sliced on the `- name:` lines as publish-step-gating does. */
const stepsOf = (id: string): Step[] => {
  const text = job(id);
  const marker = "\n      - name: ";
  const steps: Step[] = [];
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1)) {
    const next = text.indexOf(marker, at + 1);
    const body = next === -1 ? text.slice(at) : text.slice(at, next);
    steps.push({ name: body.slice(marker.length, body.indexOf("\n", marker.length)).trim(), body });
  }
  expect(steps.length, `no steps found in the ${id} job — the slicing has stopped matching`).toBeGreaterThan(1);
  return steps;
};

const names = (id: string) => stepsOf(id).map(s => s.name);

const step = (id: string, name: string): Step => {
  const found = stepsOf(id).find(s => s.name === name);
  expect(found, `no step in the ${id} job is named "${name}" any more`).toBeDefined();
  return found!;
};

const conditionOf = (s: Step): string | null => s.body.match(/\n {8}if: (.*)/)?.[1].trim() ?? null;

/** The manifest the signing loop writes, relative to desktop/ (the step's
 *  working directory), read from the loop itself. */
const macManifest = (): string => {
  const found = step("desktop", "Sign the updates").body.match(/node scripts\/sign-update\.mjs "\$zip" "\$VERSION" "\$arch" (\S+)/);
  expect(found, "the signing loop no longer calls sign-update.mjs with a zip, the version, the CPU and a manifest").not.toBeNull();
  return found![1];
};

const VERSION_FROM_ROOT = `VERSION=$(node -p "require('../package.json').version")`;

describe("the desktop build", () => {
  it("refuses a tagged build it could not sign, before anything else runs", () => {
    // HAS_SIGNING stands for the update key: that is the one secret without
    // which every update this release ships is refused by every installed app.
    expect(job("desktop")).toContain("HAS_SIGNING: ${{ secrets.CCDECK_UPDATE_KEY != '' }}");
    const order = names("desktop");
    expect(order[order.indexOf("Setup Node") + 1], "the unsigned-tag gate is no longer the first thing the build does").toBe("Refuse to release unsigned");
    const gate = step("desktop", "Refuse to release unsigned");
    expect(conditionOf(gate)).toBe("${{ startsWith(github.ref, 'refs/tags/v') && env.HAS_SIGNING != 'true' }}");
    expect(gate.body).toMatch(/\n\s+exit 1\n/);
  });

  it("hands the Mac build ccdeck's certificate whenever it has the keys, before it packages", () => {
    const identity = step("desktop", "Signing identity");
    expect(conditionOf(identity)).toBe("runner.os == 'macOS' && env.HAS_SIGNING == 'true'");
    expect(identity.body).toContain("CERT: ${{ secrets.CCDECK_MAC_CERT }}");
    expect(identity.body).toContain("KEY: ${{ secrets.CCDECK_MAC_KEY }}");
    // What scripts/sign-mac.cjs reads. Named without the file being there and it
    // now refuses; not named at all and it signs ad-hoc, so these two lines are
    // the difference between one app across updates and a new one every time.
    expect(identity.body).toMatch(/echo "CCDECK_SIGNING_CERT=[^"]+" >> "\$GITHUB_ENV"/);
    expect(identity.body).toMatch(/echo "CCDECK_SIGNING_KEY=[^"]+" >> "\$GITHUB_ENV"/);
    const order = names("desktop");
    expect(order.indexOf("Signing identity")).toBeLessThan(order.indexOf("Package"));
  });

  it("packages the root package's version, and leaves publishing to the release job", () => {
    // desktop/package.json carries a version of its own that nothing keeps in
    // step; the one the app reports, and compares a manifest against, is this.
    const pack = step("desktop", "Package");
    expect(pack.body).toContain("working-directory: desktop");
    expect(pack.body).toContain(VERSION_FROM_ROOT);
    expect(pack.body).toContain('-c.extraMetadata.version="$VERSION"');
    expect(pack.body).toContain("--config electron-builder.config.cjs");
    expect(pack.body).toContain("--publish never");
  });

  it("signs the updates after packaging, on every OS, whenever it has the key", () => {
    const sign = step("desktop", "Sign the updates");
    expect(conditionOf(sign)).toBe("env.HAS_SIGNING == 'true'");
    expect(sign.body).toContain("CCDECK_UPDATE_KEY: ${{ secrets.CCDECK_UPDATE_KEY }}");
    expect(sign.body).toContain("working-directory: desktop");
    // The manifest's version is the one the app is packaged with.
    expect(sign.body).toContain(VERSION_FROM_ROOT);
    expect(sign.body).toMatch(/for zip in dist\/app\/\S+\.zip; do/);
    expect(macManifest()).toBe("dist/app/latest-mac.json");
    expect(sign.body).toContain("node scripts/sign-yml.mjs dist/app");
    const order = names("desktop");
    expect(order.indexOf("Sign the updates")).toBeGreaterThan(order.indexOf("Package"));
    expect(order.indexOf("Sign the updates")).toBeLessThan(order.indexOf("Upload the installers"));
  });

  it("uploads every manifest an installed app reads, and fails when one is missing", () => {
    const upload = step("desktop", "Upload the installers");
    expect(upload.body).toContain("if-no-files-found: error");
    const paths = upload.body.split("\n").map(l => l.trim()).filter(l => l.startsWith("desktop/"));
    // The Mac manifest by the name the loop wrote, the Windows and Linux ones
    // by electron-builder's, and every file they list.
    expect(paths).toContain(`desktop/${macManifest()}`);
    expect(paths).toContain("desktop/dist/app/latest*.yml");
    for (const kind of ["zip", "dmg", "exe", "AppImage", "deb", "blockmap"]) expect(paths).toContain(`desktop/dist/app/*.${kind}`);
  });
});

describe("the release", () => {
  it("waits for every OS's build and for the npm publish, and runs only on a tag", () => {
    // After the npm publish, so the release never announces a version npm does
    // not have.
    const release = job("desktop-release");
    expect(release).toContain("\n    needs: [desktop, publish]\n");
    expect(release).toContain("\n    if: ${{ startsWith(github.ref, 'refs/tags/v') }}\n");
    // It collects what the build uploaded, by the name the build gave it.
    expect(step("desktop", "Upload the installers").body).toContain("name: desktop-${{ runner.os }}");
    expect(step("desktop-release", "Collect the installers").body).toContain("pattern: desktop-*");
  });
});

describe("what the build names, and what the installed app looks for", () => {
  /** electron-builder's `${macro}` expansion, for the macros artifactName uses. */
  const expand = (template: string, macros: Record<string, string>) =>
    template.replace(/\$\{(\w+)\}/g, (whole, key: string) => {
      expect(macros, `artifactName uses \${${key}}, which this test does not expand`).toHaveProperty(key);
      return macros[key];
    });

  /** A shell glob as a regex, `*` and `?` only — what the loop and its
   *  parameter expansion use. */
  const globRe = (glob: string, lazy = false) =>
    glob.split("").map(c => (c === "*" ? (lazy ? ".*?" : ".*") : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("");

  /** The CPU the signing loop reads out of a zip's path: its own two lines,
   *  evaluated rather than restated — basename, then `${arch#…}` or
   *  `${arch##…}`, the shortest or the longest matching prefix removed. */
  const loopArch = (zipPath: string) => {
    const body = step("desktop", "Sign the updates").body;
    const parse = body.match(/arch=\$\(basename "\$zip" (\S+)\); arch=\$\{arch(##?)([^}]+)\}/);
    expect(parse, "the signing loop no longer reads the CPU as basename-then-strip-a-prefix; this test has to learn the new form").not.toBeNull();
    const [, suffix, op, glob] = parse!;
    const name = basename(zipPath);
    const stem = name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
    return stem.replace(new RegExp(`^${globRe(glob, op === "#")}`), "");
  };

  it.each(["arm64", "x64"])("names the %s zip so the loop reads back exactly the CPU the app compares", (arch) => {
    const name = expand(config.artifactName, { productName: config.productName, os: "mac", arch, ext: "zip" });
    const loopGlob = step("desktop", "Sign the updates").body.match(/for zip in (\S+); do/)![1];
    expect(`dist/app/${name}`, "the loop's glob no longer matches the zip electron-builder writes").toMatch(new RegExp(`^${globRe(loopGlob)}$`));
    // The value pickFile compares against process.arch, which is what a Mac
    // running this build reports.
    expect(loopArch(`dist/app/${name}`)).toBe(arch);
    const manifest = { version: "3.27.0", files: [{ arch: loopArch(`dist/app/${name}`), url: name }] };
    expect(pickFile(manifest, arch)?.url).toBe(name);
  });

  it("points the app's feed at the repository the builds are published to", () => {
    const [target] = config.publish;
    expect(target.provider).toBe("github");
    expect(FEED).toBe(`https://github.com/${target.owner}/${target.repo}/releases/latest/download`);
  });

  describe("the Mac manifest", () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    afterEach(() => {
      Object.defineProperty(process, "platform", realPlatform);
      vi.unstubAllGlobals();
    });

    it("is asked for by the name the release job writes and uploads", async () => {
      Object.defineProperty(process, "platform", { ...realPlatform, value: "darwin" });
      const asked: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string) => { asked.push(String(url)); return { ok: false, status: 404 }; }));
      const u = createUpdater({
        app: { isPackaged: true, getVersion: () => "3.26.0", getPath: () => "/Applications/ccdeck.app/Contents/MacOS/ccdeck" },
        onChange: () => {},
      });
      await u.check();
      expect(asked).toEqual([`${FEED}/${basename(macManifest())}`]);
      expect(u.state).toEqual({ status: "error", error: "manifest 404" });
    });
  });
});

// A throwaway self-signed certificate, made for this file with
//   openssl req -x509 -newkey ed25519 -keyout /dev/null -nodes …
// and its key discarded — nothing can be signed with it. Its SHA-1 as openssl
// prints it, `openssl x509 -noout -fingerprint -sha1`, is FIXTURE_SHA1.
const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIBbzCCASGgAwIBAgIUHAsBTnmAgk+S2CAgyohfL+EFFTMwBQYDK2VwMCwxKjAo
BgNVBAMMIWNjZGVjayB0ZXN0IGZpeHR1cmUgKG5vIGtleSBrZXB0KTAgFw0yNjA5
MjExNzU0MzZaGA8yMTI2MDgyODE3NTQzNlowLDEqMCgGA1UEAwwhY2NkZWNrIHRl
c3QgZml4dHVyZSAobm8ga2V5IGtlcHQpMCowBQYDK2VwAyEAF7TSBcoJwZq9g/xF
DcUxdzR4UO/ClYivMbzHHmu8JPqjUzBRMB0GA1UdDgQWBBR2Vf68XKNOldRmbnsA
2U6ijy552DAfBgNVHSMEGDAWgBR2Vf68XKNOldRmbnsA2U6ijy552DAPBgNVHRMB
Af8EBTADAQH/MAUGAytlcANBAGsJ0/aI6LbKmUYY/gYk51bnuKd18hRPCeSjyGQ3
tpm1OzbGHDJEpH/kKy0W9kDv99WTuxiCqvc92YopWLZm9wM=
-----END CERTIFICATE-----
`;
const FIXTURE_SHA1 = "a284cbea70494451120f1585b46527a09b837553";

describe("the macOS signature the build makes", () => {
  it("pins the certificate by the SHA-1 of its DER, the hash codesign compares", () => {
    // Only requirementForLeaf's wording was tested; the hash it is handed was
    // not. A hash of the PEM text, or a SHA-256, is a requirement no build can
    // ever satisfy — and the running app is what check 4 reads it from.
    expect(requirementFor(FIXTURE_CERT, "dev.ccdeck.app")).toBe(requirementForLeaf(FIXTURE_SHA1, "dev.ccdeck.app"));
    expect(new X509Certificate(FIXTURE_CERT).fingerprint.replace(/:/g, "").toLowerCase()).toBe(FIXTURE_SHA1);
  });

  describe("without its certificate", () => {
    const KEYS = ["CCDECK_SIGNING_CERT", "CCDECK_SIGNING_KEY", "CI", "HOME", "USERPROFILE"] as const;
    const saved: Record<string, string | undefined> = {};
    let dir = "";
    const context = () => ({
      electronPlatformName: "darwin",
      appOutDir: join(dir, "mac-arm64"),
      packager: { appInfo: { productFilename: "ccdeck", id: "dev.ccdeck.app" } },
    });

    const begin = () => {
      dir = mkdtempSync(join(tmpdir(), "ccdeck-sign-mac-"));
      for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
      // The default key folder is under the home directory, and the machine
      // running this may well have the real one there.
      process.env.HOME = dir;
      process.env.USERPROFILE = dir;
    };
    afterEach(() => {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      vi.restoreAllMocks();
      rmTempDir(dir);
    });

    it("refuses to build when a certificate was named and is not there", async () => {
      // CI names both files only after writing them. A name with no file behind
      // it is a setup that went wrong, and signing ad-hoc anyway would ship an
      // app every later update is refused over.
      begin();
      process.env.CI = "true";
      process.env.CCDECK_SIGNING_CERT = join(dir, "ccdeck-signing.cert.pem");
      process.env.CCDECK_SIGNING_KEY = join(dir, "ccdeck-signing.key.pem");
      await expect(signMac(context())).rejects.toThrow(/does not exist/);
    });

    it("leaves a build that names no certificate ad-hoc, and says so — a fork's pull request is one", async () => {
      begin();
      process.env.CI = "true";
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Resolving at all is the proof it signed nothing: csreq and rcodesign are
      // not there to be run on most machines this suite runs on.
      await expect(signMac(context())).resolves.toBeUndefined();
      expect(warn.mock.calls.flat().join(" ")).toMatch(/ad-hoc/);
    });
  });
});

// What a Linux download needs from the system before the app runs a line of
// its own code. Both of these shipped, and both read to the person as the file
// doing nothing at all:
//
//   · the AppImage runtime. Left to its default, electron-builder still packs
//     the 2020 AppImageKit runtime, which dlopens libfuse.so.2 — and Ubuntu
//     24.04 and up, Fedora 40 and up and Arch install no libfuse2. The one
//     file ccdeck.dev offers first then prints "AppImages require FUSE to run"
//     to a terminal nobody opened, and exits.
//   · the name the desktop entry, the WM class and Electron's Wayland app_id
//     are matched on. StartupWMClass said "ccdeck" — the product name — while
//     the entry and the app_id both said ccdeck-desktop, so the hint meant to
//     tie a running window to its entry named a class no window of ours has.
describe("what a Linux download needs from the system", () => {
  it("packs an AppImage runtime that brings its own FUSE", () => {
    const appimage = (config as { toolsets?: { appimage?: string } }).toolsets?.appimage;
    expect(appimage, "toolsets.appimage unset — the build falls back to the libfuse2 runtime").toBeDefined();
    expect(appimage, '"0.0.0" IS the libfuse2 runtime, by that name').not.toBe("0.0.0");
    expect(appimage, "an appimage toolset is named by version").toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("gives the entry file, the WM class and the app_id one name", () => {
    const meta = require("../../../desktop/package.json");
    expect(config.linux?.syncDesktopName, "without this the entry file is named for the executable and the WM class for the product").toBe(true);
    // Electron's app_id on Wayland is the packaged package.json name, and
    // both the entry filename and StartupWMClass follow desktopName. The three
    // have to be one string or GNOME shows a running ccdeck as an unnamed
    // window with a blank icon instead of the one it was launched from.
    expect(meta.desktopName, "desktopName must be the name Electron reports as app_id").toBe(meta.name);
  });
});
