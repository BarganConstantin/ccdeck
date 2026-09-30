// A release-candidate tag must not become GitHub's Latest release (#1756).
//
// `v3.33.0-rc.1` matches the `v*.*.*` trigger, and #976 already keeps such a
// build off npm's `latest`. The desktop half of the same workflow created an
// ordinary release for it, and GitHub makes a new ordinary release Latest: it
// does not read a prerelease off the tag name. Every installed desktop app
// follows releases/latest — the Mac's latest-mac.json, electron-updater's
// `/releases/latest` on Windows and Linux — and so does every download link on
// the README and the site, so all of them would have been handed the
// candidate, and 3.33.0-rc.1 counts as newer than 3.32.0.
//
// The step's own script is run here, as the runner runs it, with a `gh` on
// PATH that writes down what it was asked and publishes nothing. bash is not
// on the Windows leg's PATH as a POSIX shell this can rely on, so the block is
// gated there and registered in skip-gates.mjs; it runs on Linux and macOS.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The `run: |` block of the desktop-release job's "Create the release" step,
 *  dedented — the script the runner hands to bash. */
function createReleaseScript(): string {
  const yml = readFileSync(join(repo, ".github", "workflows", "publish.yml"), "utf8");
  const at = yml.indexOf("\n  desktop-release:\n");
  expect(at, "publish.yml no longer has a `desktop-release:` job").toBeGreaterThan(-1);
  const job = yml.slice(at + 1);
  const stepAt = job.indexOf("\n      - name: Create the release\n");
  expect(stepAt, "the desktop-release job no longer has a \"Create the release\" step").toBeGreaterThan(-1);
  const lines = job.slice(stepAt + 1).split("\n");
  const runAt = lines.findIndex(l => l === "        run: |");
  expect(runAt, "the step no longer has a `run: |` block").toBeGreaterThan(-1);
  const body: string[] = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  const script = body.join("\n");
  // Nothing for the runner to substitute first, so this is the whole script.
  expect(script).not.toContain("${{");
  return script;
}

describe.skipIf(process.platform === "win32")("the GitHub release a tag makes", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccdeck-release-1756-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // Every call on a line of its own, then each argument on its own line.
    // `api` answers as a lightweight tag does; `release view` says there is no
    // release yet, which is the path that creates one.
    writeFileSync(join(bin, "gh"), [
      "#!/bin/sh",
      'printf "%s\\n" "--call--" "$@" >> "$GH_LOG"',
      'case "$1 $2" in',
      '  "api "*) echo \'{"object":{"type":"commit","sha":"0000000"}}\' ;;',
      '  "release view") exit 1 ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(join(bin, "gh"), 0o755);
    mkdirSync(join(dir, "release"));
    for (const f of ["latest.yml", "latest-linux.yml", "latest-mac.json", "ccdeck-mac-arm64.dmg"]) writeFileSync(join(dir, "release", f), "x");
    writeFileSync(join(dir, "create-release.sh"), createReleaseScript());
  });
  afterEach(() => rmTempDir(dir));

  /** The argv of the `gh release create` the step ran for `tag`. */
  const createdFor = (tag: string): string[] => {
    const log = join(dir, `gh-${tag}.log`);
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "create-release.sh"], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        GITHUB_REF_NAME: tag,
        GITHUB_REPOSITORY: "BarganConstantin/ccdeck",
        GH_TOKEN: "not a token",
        GH_LOG: log,
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(log), "the step never called gh").toBe(true);
    const calls = readFileSync(log, "utf8").split("--call--\n").slice(1).map(c => c.split("\n").slice(0, -1));
    const create = calls.find(c => c[0] === "release" && c[1] === "create");
    expect(create, `no \`gh release create\` among ${JSON.stringify(calls)}`).toBeDefined();
    expect(create![2]).toBe(tag);
    return create!;
  };

  it("publishes a prerelease as one, and never as Latest", () => {
    for (const tag of ["v3.33.0-rc.1", "v3.33.0-beta.2", "v4.0.0-0"]) {
      const argv = createdFor(tag);
      expect(argv, tag).toContain("--prerelease");
      expect(argv, tag).toContain("--latest=false");
    }
  });

  it("publishes a release as Latest, which is what the apps and the links follow", () => {
    const argv = createdFor("v3.33.0");
    expect(argv).not.toContain("--prerelease");
    expect(argv).not.toContain("--latest=false");
    expect(argv).toContain("--latest");
  });
});

// The footer under every release's notes (#1859). Read from the script rather
// than run, so it holds on all three legs without a gate of its own.
describe("the footer a release's notes end on", () => {
  it("is appended once, after the text is written and before the release is made", () => {
    const lines = createReleaseScript().split("\n");
    const writes = lines.flatMap((l, i) => (/[^>]> notes\.md$/.test(l) ? [i] : []));
    const appends = lines.flatMap((l, i) => (l.includes(">> notes.md") ? [i] : []));
    const create = lines.findIndex(l => l.includes("gh release create"));
    // Both branches write the file fresh, so a re-run cannot stack a second copy.
    expect(writes).toHaveLength(2);
    expect(appends).toHaveLength(1);
    expect(appends[0]).toBeGreaterThan(Math.max(...writes));
    expect(appends[0]).toBeLessThan(create);
    // A quoted heredoc: nothing in the footer is expanded or run.
    expect(lines[appends[0]]).toMatch(/<<'FOOTER'$/);
    const footer = lines.slice(appends[0] + 1, lines.indexOf("FOOTER", appends[0]));
    // The blank line keeps markdown from turning the line above `---` into a
    // heading.
    expect(footer.slice(0, 2)).toEqual(["", "---"]);
    expect(footer.join("\n")).toContain("https://ccdeck.dev/guides/");
  });
});
