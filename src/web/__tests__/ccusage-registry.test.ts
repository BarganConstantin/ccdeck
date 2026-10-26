// ccusage fetched from the npm registry with no npm (ccusage-registry.mjs).
//
// The desktop app on a machine without Node had no way to get ccusage: the
// managed install is `npm install` and the fallback is `npx`, and the boot log
// on a clean Windows VM said `'"npm.cmd"' is not recognized` for both. The deck
// now asks the registry for ccusage and its native package itself, checks each
// tarball against the sha512 the registry publishes, and unpacks both where npm
// would have put them.
//
// Everything here runs against a registry made of a function and tarballs built
// in memory, so nothing is downloaded and every case can say what the registry
// answered. The tarballs are written the way npm writes them: a `package/` top
// directory, ustar headers, gzip.
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { NATIVE, NATIVE_BIN as BIN, fakeRegistry as registry, pax, sri, tarHeader as header, tgz } from "./fake-npm-registry";

const {
  fetchCcusage, integrityMatches, latestCcusage, nativePackageName, packageVersion, registryBase, tarEntries, unpack,
  // @ts-expect-error — .mjs server module, no types
} = await import("../../server/ccusage-registry.mjs");
// @ts-expect-error — .mjs server module, no types
const { npmAvailable } = await import("../../server/ccusage-install.mjs");

const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-ccusage-registry-"));
afterAll(() => rmTempDir(ROOT));
let n = 0;
const freshDir = () => join(ROOT, `case-${++n}`);

describe("the registry it asks", () => {
  it("is the public npm registry unless the environment names one", () => {
    expect(registryBase({})).toBe("https://registry.npmjs.org");
    expect(registryBase({ npm_config_registry: "https://npm.corp.example/repo/" })).toBe("https://npm.corp.example/repo");
  });

  it("asks for a scoped package with its slash escaped", async () => {
    const reg = registry();
    await packageVersion(NATIVE, "20.1.0", reg);
    expect(reg.asked).toEqual([`https://reg.test/${NATIVE.replace("/", "%2F")}/20.1.0`]);
  });

  it("refuses a spec that is not a version or a tag", async () => {
    await expect(packageVersion("ccusage", "../../evil", registry())).rejects.toThrow(/not a version or tag/);
  });
});

describe("the native package", () => {
  it("is named the way ccusage's own cli.js names it", () => {
    expect(nativePackageName("win32", "x64")).toBe("@ccusage/ccusage-win32-x64");
    expect(nativePackageName("darwin", "arm64")).toBe("@ccusage/ccusage-darwin-arm64");
    expect(nativePackageName("linux", "x64")).toBe("@ccusage/ccusage-linux-x64");
  });

  it("does not exist for a platform ccusage publishes no build for", () => {
    expect(nativePackageName("freebsd", "x64")).toBeNull();
    expect(nativePackageName("win32", "ia32")).toBeNull();
  });
});

describe("the integrity check", () => {
  const bytes = Buffer.from("a tarball");

  it("accepts the bytes the sha512 was published for", () => {
    expect(integrityMatches(bytes, sri(bytes))).toBe(true);
    expect(integrityMatches(bytes, `sha1-abc ${sri(bytes)}`)).toBe(true);
  });

  it("refuses other bytes, and a record with no sha512 in it", () => {
    expect(integrityMatches(Buffer.from("other bytes"), sri(bytes))).toBe(false);
    expect(integrityMatches(bytes, "sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=")).toBe(false);
    expect(integrityMatches(bytes, "")).toBe(false);
  });
});

describe("unpacking a tarball", () => {
  it("drops npm's top directory and keeps a pax long name", async () => {
    const long = `package/${"deep/".repeat(30)}file.txt`;
    const dest = freshDir();
    await unpack(tgz([{ name: "package/a.txt", body: "A" }, pax(long), { name: "ignored-short-name", body: "L" }]), dest);
    expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("A");
    expect(readFileSync(join(dest, ...long.split("/").slice(1)), "utf8")).toBe("L");
  });

  it("skips links rather than following them", async () => {
    const dest = freshDir();
    await unpack(tgz([{ name: "package/link", type: "2", link: "/etc/passwd" }, { name: "package/ok", body: "1" }]), dest);
    expect(readdirSync(dest)).toEqual(["ok"]);
  });

  it("refuses an archive that names a path outside itself", async () => {
    for (const name of ["package/../escaped", "package/C:evil", "package/sub/../../escaped"]) {
      const dest = freshDir();
      await expect(unpack(tgz([{ name, body: "x" }]), dest), name).rejects.toThrow(/outside itself/);
      expect(existsSync(join(dest, "..", "escaped"))).toBe(false);
    }
  });

  it("refuses a truncated archive", () => {
    const tar = Buffer.concat([header("package/a", 4096, "0", 0o644), Buffer.alloc(100)]);
    expect(() => [...tarEntries(tar)]).toThrow(/truncated/);
  });
});

describe("fetching ccusage", () => {
  it("puts ccusage and this platform's native package where npm and cli.js look for them", async () => {
    const pkgDir = join(freshDir(), "node_modules", "ccusage");
    const reg = registry();
    expect(await fetchCcusage({ pkgDir, ...reg })).toBe("20.1.0");
    expect(JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version).toBe("20.1.0");
    expect(existsSync(join(pkgDir, "src", "cli.js"))).toBe(true);
    // Inside ccusage's own node_modules: the first place Node's resolution
    // from src/cli.js looks, so cli.js and nativeCcusage both find it.
    expect(readFileSync(join(pkgDir, "node_modules", ...NATIVE.split("/"), ...BIN.split("/")), "utf8")).toBe("binary");
    // Only this machine's native package was downloaded, never the others.
    expect(reg.asked.some(u => u.includes("other-arch"))).toBe(false);
  });

  it("refuses a tarball that does not match its published integrity, and installs nothing", async () => {
    for (const tamper of ["main", "native"] as const) {
      const dir = freshDir();
      const pkgDir = join(dir, "node_modules", "ccusage");
      await expect(fetchCcusage({ pkgDir, ...registry({ tamper }) }), tamper).rejects.toThrow(/does not match the integrity/);
      expect(existsSync(pkgDir)).toBe(false);
    }
  });

  it("leaves a working copy in place when the new one cannot be fetched", async () => {
    const dir = freshDir();
    const pkgDir = join(dir, "node_modules", "ccusage");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    await expect(fetchCcusage({ pkgDir, ...registry({ status: 503 }) })).rejects.toThrow(/answered 503/);
    expect(JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version).toBe("1.0.0");
  });

  it("replaces an older copy whole, and leaves no staging or old directory behind", async () => {
    const dir = freshDir();
    const pkgDir = join(dir, "node_modules", "ccusage");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    writeFileSync(join(pkgDir, "stale-file.js"), "");
    await fetchCcusage({ pkgDir, spec: "20.1.0", ...registry() });
    expect(JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version).toBe("20.1.0");
    expect(existsSync(join(pkgDir, "stale-file.js"))).toBe(false);
    expect(readdirSync(join(dir, "node_modules"))).toEqual(["ccusage"]);
  });

  it("says so on a platform ccusage publishes no build for, before downloading anything", async () => {
    const reg = registry();
    await expect(fetchCcusage({ pkgDir: join(freshDir(), "x"), platform: "freebsd", ...reg })).rejects.toThrow(/no build for freebsd/);
    expect(reg.asked).toEqual([]);
  });

  it("reads the latest version for the daily update check", async () => {
    expect(await latestCcusage(registry({ version: "21.0.0" }))).toBe("21.0.0");
  });
});

describe("telling whether this machine has an npm", () => {
  const only = (...files: string[]) => (p: string) => files.includes(p);

  it("finds none for the desktop app on a Windows machine without Node", () => {
    expect(npmAvailable("win32", {
      execPath: "C:\\Users\\u\\AppData\\Local\\Programs\\ccdeck\\ccdeck.exe",
      pathEnv: "C:\\Windows\\system32;C:\\Users\\u\\.local\\bin",
      exists: only(),
    })).toBe(false);
  });

  it("finds Windows npm beside Node, or on PATH", () => {
    expect(npmAvailable("win32", {
      execPath: "C:\\Program Files\\nodejs\\node.exe", pathEnv: "", exists: only("C:\\Program Files\\nodejs\\npm.cmd"),
    })).toBe(true);
    expect(npmAvailable("win32", {
      execPath: "C:\\Users\\u\\AppData\\Local\\Programs\\ccdeck\\ccdeck.exe",
      pathEnv: "C:\\Windows\\system32;C:\\Program Files\\nodejs",
      exists: only("C:\\Program Files\\nodejs\\npm.cmd"),
    })).toBe(true);
  });

  it("finds none for the desktop app on macOS or Linux without Node", () => {
    expect(npmAvailable("darwin", {
      execPath: "/Applications/ccdeck.app/Contents/MacOS/ccdeck", pathEnv: "/usr/bin:/bin", exists: only(),
    })).toBe(false);
  });

  it("finds npm-cli.js beside Node, or npm on PATH", () => {
    expect(npmAvailable("linux", {
      execPath: "/usr/local/bin/node", pathEnv: "", exists: only("/usr/local/lib/node_modules/npm/bin/npm-cli.js"),
    })).toBe(true);
    expect(npmAvailable("darwin", {
      execPath: "/Applications/ccdeck.app/Contents/MacOS/ccdeck", pathEnv: "/usr/bin:/opt/homebrew/bin",
      exists: only("/opt/homebrew/bin/npm"),
    })).toBe(true);
  });
});
