import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { rmTempDir } from "./rm-temp-dir";

const require = createRequire(import.meta.url);
const { runtimeResources, validateRuntime } = require("../../../desktop/scripts/deck-runtime.cjs");
const config = require("../../../desktop/electron-builder.config.cjs");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temps: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "ccdeck-runtime-packaging-"));
  temps.push(dir);
  return dir;
};
afterEach(() => { for (const dir of temps.splice(0)) rmTempDir(dir); });

function pkg(root: string, location: string, data: object) {
  const dir = join(root, location);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(data));
  return dir;
}

describe("the desktop hosted server's runtime packages", () => {
  it("resolves the installed production graph, including nested conflicting versions", () => {
    const root = temp();
    pkg(root, ".", { dependencies: { first: "1", second: "1" }, devDependencies: { tooling: "1" } });
    pkg(root, "node_modules/first", { name: "first", dependencies: { shared: "1" } });
    pkg(root, "node_modules/second", { name: "second", dependencies: { shared: "2" } });
    pkg(root, "node_modules/shared", { name: "shared", version: "1", dependencies: { first: "1" } });
    pkg(root, "node_modules/second/node_modules/shared", { name: "shared", version: "2" });
    pkg(root, "node_modules/tooling", { name: "tooling" });
    expect(runtimeResources(root).map((entry: { to: string }) => entry.to).sort()).toEqual([
      "deck/node_modules/first", "deck/node_modules/second",
      "deck/node_modules/second/node_modules/shared", "deck/node_modules/shared",
    ]);
  });

  it("fails when a required transitive package is missing", () => {
    const root = temp();
    pkg(root, ".", { dependencies: { first: "1" } });
    pkg(root, "node_modules/first", { dependencies: { missing: "1" } });
    expect(() => runtimeResources(root)).toThrow("Missing deck runtime dependency missing");
  });

  it("documents every shipped runtime package's installed version and licence", () => {
    const notices = readFileSync(join(repo, "THIRD_PARTY_NOTICES.md"), "utf8");
    for (const entry of runtimeResources(repo)) {
      const { name, version, license } = JSON.parse(readFileSync(join(entry.from, "package.json"), "utf8"));
      expect(notices).toContain(`| \`${name}\` | ${version} | ${license} |`);
      expect(readFileSync(join(entry.from, "LICENSE"), "utf8")).toContain("Apache License");
    }
  });

  it.each([
    ["darwin", 1], ["darwin", 3], ["darwin", 4], ["linux", 1], ["win32", 1],
  ])("has prebuilds for the packaged target %s / %s", (platform, arch) => {
    expect(() => config.beforePack({ electronPlatformName: platform, arch })).not.toThrow();
  });

  it("rejects unsupported targets before packaging", () => {
    expect(() => validateRuntime({ electronPlatformName: "win32", arch: 0 })).toThrow("Missing deck native prebuild for win32-ia32");
  });

  it("refuses a universal Mac build when only the host's prebuild is installed", () => {
    const root = temp();
    pkg(root, ".", { dependencies: { "fs-native-extensions": "1" } });
    const native = pkg(root, "node_modules/fs-native-extensions", { name: "fs-native-extensions" });
    mkdirSync(join(native, "prebuilds/darwin-x64"), { recursive: true });
    writeFileSync(join(native, "prebuilds/darwin-x64/fs-native-extensions.node"), "fixture");
    expect(() => validateRuntime({ electronPlatformName: "darwin", arch: 4 }, root)).toThrow("Missing deck native prebuild for darwin-arm64");
  });

  it("loads and locks from isolated Resources/deck with transitive code, licences and both Mac prebuilds", () => {
    const resources = temp();
    // Apply the actual extraResources plan. Exclude nested node_modules while
    // copying each entry: they have their own entries in the resolved graph.
    const entries = config.extraResources.filter((entry: { to: string }) => entry.to.startsWith("deck/node_modules/"));
    expect(entries).toEqual(runtimeResources(repo));
    for (const entry of entries) {
      cpSync(entry.from, join(resources, entry.to), {
        recursive: true,
        filter: (source: string) => !relative(entry.from, source).split(sep).includes("node_modules"),
      });
      expect(readFileSync(join(resources, entry.to, "LICENSE"), "utf8")).toBe(readFileSync(join(entry.from, "LICENSE"), "utf8"));
    }
    const deck = join(resources, "deck");
    const native = join(deck, "node_modules/fs-native-extensions");
    for (const cpu of ["arm64", "x64"]) {
      expect(existsSync(join(native, "prebuilds", `darwin-${cpu}`, "fs-native-extensions.node"))).toBe(true);
    }
    const script = join(deck, "probe.cjs");
    writeFileSync(script, `
      const fs = require('node:fs');
      const path = require('node:path');
      const root = path.dirname(require.resolve('fs-native-extensions/package.json'));
      // Load the pinned binding directly, as the Node 18 server does: the
      // upstream JS loader's newer transitive releases can require Array.with.
      const { tryLock, unlock } = require(path.join(root, 'prebuilds', process.platform + '-' + process.arch, 'fs-native-extensions.node'));
      const fd = fs.openSync(${JSON.stringify(join(deck, "probe.lock"))}, 'a+');
      try { tryLock(fd, 0, 0, true); unlock(fd, 0, 0); }
      finally { fs.closeSync(fd); }
      console.log('loaded and locked');
    `);
    expect(execFileSync(process.execPath, [script], {
      cwd: deck, encoding: "utf8", env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    }).trim()).toBe("loaded and locked");
    for (const file of ["THIRD_PARTY_NOTICES.md", "LICENSE", "LICENSING.md"]) {
      expect(config.extraResources).toContainEqual({ from: `../${file}`, to: `deck/${file}` });
    }
  });
});
