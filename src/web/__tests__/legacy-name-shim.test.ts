// The two retired names, and what is published under them now.
//
// This deck was published three times under three names for its whole life.
// The README, the banner and the docs have pointed at `ccdeck` for a long time,
// so the other two stop being the deck and become a door to it: they depend on
// ccdeck, print the command to use next time, and hand over.
//
// The failure this shape exists to avoid is the one that looks like nothing.
// Simply ceasing to publish the old names would strand every deck installed
// under one of them on the version it has, for ever, with no message at all —
// because the deck checks for updates under the name it was installed as
// (README, "the package this copy would actually install"). A door keeps those
// installs on a current deck; silence would not.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const shim = readFileSync(join(ROOT, "legacy", "shim.js"), "utf8");
/** The shim with its prose taken out. The comments in that file argue AGAINST
 *  `npx` and `npm_package_name` by name, so a rule that searched the whole file
 *  would be failed by the paragraph explaining why the thing is not there. */
const shimCode = shim.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const workflow = readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf8");
const deck = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** Build one legacy package into a throwaway directory and read its manifest. */
function build(name: string) {
  const out = mkdtempSync(join(tmpdir(), "legacy-"));
  execFileSync(process.execPath, [join(ROOT, "scripts", "build-legacy.mjs"), name, out], { stdio: "pipe" });
  const manifest = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
  const files = ["package.json", "shim.js", "README.md"].filter(f => existsSync(join(out, f)));
  const readme = readFileSync(join(out, "README.md"), "utf8");
  rmSync(out, { recursive: true, force: true });
  return { manifest, files, readme };
}

const NAMES = ["agents-deck", "agent-dag"] as const;

describe("what the retired names publish", () => {
  it.each(NAMES)("%s carries the deck as a dependency, not the deck itself", name => {
    const { manifest, files } = build(name);
    expect(manifest.name).toBe(name);
    expect(manifest.dependencies).toEqual({ ccdeck: `^${deck.version.split(".")[0]}` });
    // Three files and no more: everything else lives in ccdeck, and a stray
    // file in here would be published without appearing in the builder.
    expect(files.sort()).toEqual(["README.md", "package.json", "shim.js"]);
  });

  it.each(NAMES)("%s keeps the command that has always worked", name => {
    const { manifest } = build(name);
    expect(manifest.bin).toEqual({ [name]: "shim.js" });
  });

  it.each(NAMES)("%s ships at the deck's own version, so the two can be compared", name => {
    expect(build(name).manifest.version).toBe(deck.version);
  });

  it.each(NAMES)("%s says where to go, in the two places npm shows before install", name => {
    const { manifest, readme } = build(name);
    expect(manifest.description).toMatch(/ccdeck/);
    expect(readme).toMatch(/npx ccdeck/);
  });

  it("pins the dependency to a major line rather than to anything", () => {
    // `*` would let a name pinned in a three-year-old lockfile pull a deck two
    // majors newer than the one it was written beside.
    const range = build("agent-dag").manifest.dependencies.ccdeck;
    expect(range).not.toBe("*");
    expect(range).toMatch(/^\^\d+$/);
  });

  it("refuses to build a name that is not retired", () => {
    // A typo here would publish a door over a real package.
    expect(() => execFileSync(process.execPath,
      [join(ROOT, "scripts", "build-legacy.mjs"), "ccdeck"], { stdio: "pipe" })).toThrow();
  });
});

describe("the door itself", () => {
  it("finds the deck through the resolver rather than by guessing a path", () => {
    // A dependency can be hoisted, nested or linked, and only the resolver
    // knows which happened.
    expect(shim).toContain('require.resolve("ccdeck/package.json")');
  });

  it("does not shell out to npx", () => {
    // It PRINTS `npx ccdeck`, which is the whole point of the notice. What it
    // must not do is RUN it: a second registry resolution on every start would
    // be slower and a hard requirement on the network even when everything
    // needed is already on disk. So the test is about the spawn, not about the
    // string.
    expect(shimCode).toContain("spawn(process.execPath");
    expect(shimCode).not.toMatch(/spawn\([^)]*npx/);
    expect(shimCode).not.toMatch(/exec(?:Sync|File|FileSync)?\(/);
  });

  it("stays out of the way of whatever is reading the output", () => {
    // The notice goes to stderr so a script reading stdout is unaffected, and
    // the deck inherits the terminal so its own output is unchanged.
    expect(shim).not.toMatch(/process\.stdout\.write/);
    expect(shim).toContain('stdio: "inherit"');
  });

  it("passes every argument through untouched", () => {
    expect(shim).toContain("...process.argv.slice(2)");
  });

  it("exits as the deck exited, signal included", () => {
    // A supervisor reading the code has to see what the deck did, not what a
    // wrapper decided.
    expect(shim).toContain("process.kill(process.pid, signal)");
    expect(shim).toContain("process.exit(code ?? 0)");
  });

  it("names itself from its own manifest, because npm does not name a bin", () => {
    // `npm_package_name` is set for lifecycle scripts and not for a bin, so
    // reading it printed "this package is the old name" to everybody.
    expect(shimCode).not.toMatch(/npm_package_name/);
    expect(shimCode).toContain('new URL("./package.json", import.meta.url)');
  });

  it("says what to run when the deck is not beside it", () => {
    expect(shim).toMatch(/could not be found beside it/);
    expect(shim).toContain("process.exit(1)");
  });
});

describe("the release publishes doors and not decks", () => {
  it.each(NAMES)("builds %s rather than renaming the deck's own manifest", name => {
    expect(workflow).toContain(`node scripts/build-legacy.mjs ${name} dist/legacy/${name}`);
    expect(workflow).toContain(`npm publish dist/legacy/${name} --provenance --access public`);
  });

  it("still publishes the real deck under ccdeck", () => {
    expect(workflow).toContain("npm pkg set name=ccdeck");
  });

  it("renames nothing for the retired names any more", () => {
    for (const name of NAMES) expect(workflow).not.toContain(`npm pkg set name=${name}`);
  });
});
