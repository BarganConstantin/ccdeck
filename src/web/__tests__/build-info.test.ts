// Which build a package is, when it is not a release. A pull request's CI
// package and desktop installers carry the version of the release they were
// branched from, so the version alone cannot tell a test build from the
// release. The CI writes the branch and commit beside the server
// (src/server/build-info.json) for a pull request only; `ccdeck --version`,
// /api/version and the version chip say them. The version itself is never
// touched, so the deck's update check reads a test build exactly as it reads
// the release, and a release never carries the file.
import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_INFO_PATH, readBuildInfo, versionWithBuild, writeBuildInfo } from "../../server/build-info.mjs";
import { versionChipLabel, versionChipTitle } from "../version-chip";
import { rmTempDir } from "./rm-temp-dir";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
const made: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "ccdeck-build-info-")); made.push(d); return d; };
afterAll(() => { for (const d of made) rmTempDir(d); });

const workflow = readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf8");
/** One job of the workflow, from its key to the next job's. */
function job(name: string): string {
  const at = workflow.indexOf(`\n  ${name}:\n`);
  if (at < 0) return "";
  const next = workflow.slice(at + 1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? workflow.slice(at) : workflow.slice(at, at + 1 + next);
}

describe("what a build says about itself", () => {
  it("is the version alone for a release, and the version with its branch and commit for a test build", () => {
    expect(versionWithBuild("3.38.1", null)).toBe("3.38.1");
    expect(versionWithBuild("3.38.1", { branch: "feature/git-view", sha: "abc1234def5678" })).toBe("3.38.1 (feature/git-view @ abc1234)");
  });

  it("is read from the file the CI writes, and nothing a hand-edited or broken file says is trusted", () => {
    const dir = temp();
    mkdirSync(join(dir, "src", "server"), { recursive: true });
    expect(readBuildInfo(dir)).toBeNull();
    writeBuildInfo(dir, { branch: "feature/git-view", sha: "ABC1234DEF5678abc1234def5678abc1234def56" });
    expect(readBuildInfo(dir)).toEqual({ branch: "feature/git-view", sha: "abc1234def5678abc1234def5678abc1234def56" });
    const file = join(dir, BUILD_INFO_PATH);
    for (const bad of ["not json", JSON.stringify({ branch: "x\ny", sha: "abc1234" }), JSON.stringify({ branch: "x", sha: "zzz" }),
      JSON.stringify({ branch: "", sha: "abc1234" }), JSON.stringify({ branch: "a".repeat(300), sha: "abc1234" }), "[]"]) {
      writeFileSync(file, bad);
      expect(readBuildInfo(dir), bad).toBeNull();
    }
  });

  it("never sits in the repository, so nothing built from a checkout carries one", () => {
    expect(existsSync(join(ROOT, BUILD_INFO_PATH))).toBe(false);
    expect(readFileSync(join(ROOT, ".gitignore"), "utf8")).toMatch(/^src\/server\/build-info\.json$/m);
  });
});

/** Run a copy of the package's bin/deck.js with `--version`. */
function versionOf(pkg: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(pkg, "bin", "deck.js"), "--version"], {
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: "1", CI: "1" },
    });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("--version did not exit")); }, 20_000);
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("exit", code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

describe("`ccdeck --version` of a package", () => {
  it("prints the bare version without the file, and the branch and commit with it, the semver left as it is", async () => {
    const pkg = temp();
    for (const part of ["bin", "hook", join("src", "server")]) cpSync(join(ROOT, part), join(pkg, part), { recursive: true });
    cpSync(join(ROOT, "package.json"), join(pkg, "package.json"));
    const release = await versionOf(pkg);
    expect(release.code).toBe(0);
    expect(release.out.trim()).toBe(VERSION);
    writeBuildInfo(pkg, { branch: "feature/git-view", sha: "abc1234def5678" });
    const test = await versionOf(pkg);
    expect(test.code).toBe(0);
    expect(test.out.trim()).toBe(`${VERSION} (feature/git-view @ abc1234)`);
    expect(test.err).toBe("");
    // The package's version is what the update check compares: untouched.
    expect(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version).toBe(VERSION);
  }, 60_000);
});

describe("the deck's version chip", () => {
  const copy = { running: "3.38.1", latest: "3.38.1", checkedAgo: "2m ago" };
  it("names the branch and commit of a test build in its tooltip and its accessible name", () => {
    const build = { branch: "feature/git-view", sha: "abc1234def5678" };
    expect(versionChipTitle({ ...copy, build })).toMatch(/^Test build 3\.38\.1 \(feature\/git-view @ abc1234\) · npm has v3\.38\.1/);
    expect(versionChipLabel({ ...copy, build })).toMatch(/^Version v3\.38\.1 \(feature\/git-view @ abc1234\), a test build, show what's new/);
  });

  it("says what it always said for a release", () => {
    expect(versionChipTitle(copy)).toMatch(/^npm has v3\.38\.1 · checked 2m ago/);
    expect(versionChipLabel(copy)).toMatch(/^Version v3\.38\.1, show what's new/);
  });

  it("is told by /api/version, beside the running version it leaves alone", () => {
    const life = readFileSync(join(ROOT, "src", "server", "lifecycle.mjs"), "utf8");
    expect(life).toMatch(/\.\.\.report, canRestart: canRestartNow\(\), invokedAs: invoked, renameFix: rename\?\.fix \?\? null, build: RUNNING_BUILD,/);
    const chip = readFileSync(join(ROOT, "src", "web", "components", "VersionChip.tsx"), "utf8");
    expect(chip).toMatch(/build: version\?\.build \?\? null,/);
  });
});

describe("the CI", () => {
  it("writes the file for a pull request's package and installers, from the event's own values, never into a release", () => {
    const floor = job("floor");
    expect(floor).toMatch(/if \[ "\$EVENT" = "pull_request" \]; then\s+node src\/server\/build-info\.mjs --write\s+fi\s+npm pack/);
    expect(floor).toMatch(/BUILD_BRANCH: \$\{\{ github\.head_ref \}\}/);
    expect(floor).toMatch(/BUILD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
    // Through the environment, never spliced into the script: a branch name is anyone's to choose.
    const lines = (j: string) => [...j.matchAll(/^.*\$\{\{ github\.(head_ref|event\.pull_request\.head\.sha) \}\}.*$/gm)].map(m => m[0].trim());
    expect(lines(floor)).toEqual(["BUILD_BRANCH: ${{ github.head_ref }}", "BUILD_SHA: ${{ github.event.pull_request.head.sha }}"]);
    const desktop = job("desktop");
    expect(desktop).toMatch(/- name: Mark a pull request's build\s+if: github\.event_name == 'pull_request'/);
    expect(lines(desktop)).toEqual(["BUILD_BRANCH: ${{ github.head_ref }}", "BUILD_SHA: ${{ github.event.pull_request.head.sha }}"]);
    expect(desktop).toMatch(/run: node src\/server\/build-info\.mjs --write\n/);
    // The publishing jobs never write one.
    for (const name of ["publish", "desktop-release"]) {
      const j = job(name);
      expect(j, name).toBeTruthy();
      expect(j, name).not.toMatch(/build-info/);
    }
  });
});

