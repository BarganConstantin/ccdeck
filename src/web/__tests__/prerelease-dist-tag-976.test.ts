// What a `v3.23.0-rc.1` tag would have done, and what it does now.
//
// Four facts lined up behind one missing flag, and each of them is individually
// reasonable:
//
//   · the tag trigger is the glob `v*.*.*`, and `*` matches any run of
//     characters that is not a `/` — so `v3.23.0-rc.1` matches it;
//   · `Verify tag matches package.json` compares two strings, and for a
//     prerelease tag over a prerelease package.json they agree, so it passes;
//   · the publish step ran a bare `npm publish`, and a bare `npm publish` moves
//     the `latest` dist-tag;
//   · `autoUpdate` defaults to true in deck-prefs.mjs, and the deck's registry
//     check asks the dist-tags endpoint for `latest`.
//
// So cutting a tag to get a build to one tester would have pointed `latest` at
// the release candidate, and within the hour every deck on the registry check
// would have installed it and restarted into it, unattended.
//
// THE SECOND HALF IS WHY THIS WAS WORTH FILING AHEAD OF THE FIRST. `isOlder`
// split on `[.\-+]` and mapped non-numeric segments to zero, so
// `3.23.0-rc.1` segmented to [3,23,0,0,1] — five numbers against the release's
// three — and sorted ABOVE `3.23.0`. Measured against the real function before
// the fix:
//
//     isOlder("3.23.0-rc.1", "3.23.0") = false     ← the release never looked newer
//     isOlder("3.23.0", "3.23.0-rc.1") = true      ← and a deck would go backwards
//
// A fleet on the candidate would therefore see no notice when the real release
// shipped, read nothing in the banner, and have no way to come back off it from
// inside the product. A bad release can be followed by a good one; a fleet that
// cannot SEE the good one cannot be rescued by publishing it.
//
// Both halves are needed and neither is sufficient. The dist-tag stops the
// fleet being moved onto a candidate; the comparator is the only thing that
// brings back a deck a tester installed one on by hand, which is the ordinary
// reason a candidate is cut at all.
//
// NOTHING HERE PUBLISHES. The workflow is read as text — the way every other
// assertion this repo makes about CI is made, since there is no YAML parser in
// the dependency tree — and the tag-choosing rule is exercised by lifting the
// `case` ARMS out of that text and matching versions against the patterns they
// actually carry. No `npm publish`, no registry request, no `npm view`, and no
// shell: spawning one would have meant a `runIf(posix)`, which in this repo
// costs a skip-gates.mjs entry, an inventory count and a number in this very
// workflow — all to run four characters of globbing that node can do.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { isOlder } from "../../server/self-update.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const publishYml = () => readFileSync(join(repo, ".github", "workflows", "publish.yml"), "utf8");

/** The release job alone — publish-step-gating.test.ts slices the same way and
 *  says why: the `test` job above carries constructs of its own that a
 *  whole-file sweep would either flag or have to special-case by name. */
const publishJob = () => {
  const yml = publishYml();
  const at = yml.indexOf("\n  publish:\n");
  expect(at, "publish.yml no longer has a `publish:` job to read").toBeGreaterThan(-1);
  return yml.slice(at);
};

const stepNamed = (needle: string): string => {
  const job = publishJob();
  const marker = "\n      - name: ";
  for (let at = job.indexOf(marker); at !== -1; at = job.indexOf(marker, at + 1)) {
    const next = job.indexOf(marker, at + 1);
    const body = next === -1 ? job.slice(at) : job.slice(at, next);
    if (body.slice(marker.length, body.indexOf("\n", marker.length)).trim().startsWith(needle)) return body;
  }
  throw new Error(`no step in the publish job is named "${needle}" any more`);
};

// ── the workflow, read ───────────────────────────────────────────────────────

describe("the publish step's dist-tag", () => {
  it("never runs a bare `npm publish`", () => {
    // The whole defect in one assertion. A publish with no `--tag` moves
    // `latest`, whatever the version says.
    const step = stepNamed("Publish to npm");
    expect(step).toMatch(/npm publish .*--tag/);
    expect(step).not.toMatch(/npm publish --provenance --access public\s*$/m);
  });

  it("chooses the tag from the version rather than from the trigger", () => {
    // Not from `github.ref`, and the difference is not academic: the job also
    // runs on `workflow_dispatch`, where there is no tag at all and the version
    // comes from package.json. A rule keyed on the ref would publish a
    // prerelease package.json to `latest` on every manual re-run.
    const step = stepNamed("Publish to npm");
    expect(step).toMatch(/VERSION=\$\(node -p "require\('\.\/package\.json'\)\.version"\)/);
    expect(step).toMatch(/case "\$VERSION" in/);
    expect(step).not.toMatch(/github\.ref/);
  });

  it("still skips a version already on the registry", () => {
    // The idempotence the step's own comment promises, so the job stays safe to
    // re-run after a token or registry problem. Asserted here because the
    // tag-choosing lines were inserted directly above it.
    const step = stepNamed("Publish to npm");
    expect(step).toMatch(/EXISTING=\$\(npm view "ccdeck@\$VERSION" version/);
    expect(step).toMatch(/already published — skipping/);
  });

  it("says which dist-tag it used in the run summary", () => {
    // "Published v3.23.0-rc.1 🚀" over an npm link is what a maintainer reads
    // as "the fleet has it", and for a prerelease that is exactly what did not
    // happen. Both branches say it, so the release case is not the silent one.
    const step = stepNamed("Summary");
    expect(step).toMatch(/dist-tag/);
    expect(step).toMatch(/latest/);
    expect(step).toMatch(/next/);
  });
});

// ── the workflow, run ────────────────────────────────────────────────────────

/** One shell glob as a RegExp. The three metacharacters a `case` pattern can
 *  carry that matter here — `*`, `?` and everything else taken literally — and
 *  it is applied to the pattern READ OUT OF THE WORKFLOW, never to one written
 *  here. A rule edited in the file and not in this test therefore fails rather
 *  than passing against a copy. */
function globToRe(glob: string): RegExp {
  const body = [...glob].map(c =>
    c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("");
  return new RegExp(`^${body}$`);
}

/** The arms of the publish step's `case`, in file order: the patterns each arm
 *  matches (a `case` arm may alternate them with `|`), and the tag it sets. */
function distTagArms(): Array<{ patterns: string[]; tag: string }> {
  const step = stepNamed("Publish to npm");
  const block = step.match(/case "\$VERSION" in\n([\s\S]*?)\n\s*esac/);
  expect(block, "the dist-tag `case` is no longer where this test reads it from").not.toBe(null);
  const arms: Array<{ patterns: string[]; tag: string }> = [];
  for (const line of block![1].split("\n")) {
    const arm = line.match(/^\s*([^)]+?)\)\s*DIST_TAG=(\S+)\s*;;/);
    if (arm) arms.push({ patterns: arm[1].split("|").map(p => p.trim()), tag: arm[2] });
  }
  expect(arms.length, "no `DIST_TAG=` arms found — the case has changed shape").toBeGreaterThan(1);
  return arms;
}

/** What the workflow's own rule answers for one version. */
function distTagFor(version: string): string {
  for (const { patterns, tag } of distTagArms()) {
    if (patterns.some(p => globToRe(p).test(version))) return tag;
  }
  throw new Error(`no arm of the publish step's case matched ${version}`);
}

describe("that `case`, evaluated against its own patterns", () => {
  it("has a catch-all arm, so no version can reach the publish untagged", () => {
    // `DIST_TAG` unset would expand to an empty string and `npm publish --tag
    // ""` is an error, not a default — but the version that got there would be
    // one nobody had thought about, which is how this class of bug starts.
    const last = distTagArms().at(-1)!;
    expect(last.patterns).toContain("*");
  });

  it("sends every prerelease spelling to `next`", () => {
    for (const v of ["3.23.0-rc.1", "3.23.0-rc1", "3.23.0-beta.1", "3.23.0-0", "4.0.0-alpha"]) {
      expect(distTagFor(v), `${v} must not move latest`).toBe("next");
    }
  });

  it("sends a release to `latest`", () => {
    for (const v of ["3.22.15", "3.23.0", "4.0.0", "10.0.1"]) {
      expect(distTagFor(v), `${v} is a release`).toBe("latest");
    }
  });

  it("treats build metadata as a release, because it is one", () => {
    // `+` is not a prerelease. `3.23.0+build.7` is the release 3.23.0 with a
    // build tag on it and belongs on `latest`; a rule that matched any
    // punctuation would have stranded it on `next` and quietly stopped the
    // fleet updating, which is the same outage from the other direction.
    expect(distTagFor("3.23.0+build.7")).toBe("latest");
  });
});

// ── and the half the dist-tag cannot fix ─────────────────────────────────────

describe("coming back off a prerelease", () => {
  it("sees the release as newer than the candidate it supersedes", () => {
    // The pair a stranded deck's hourly check actually evaluates, and the one
    // that used to answer false. This is what makes a fleet rescuable by
    // publishing a good release.
    expect(isOlder("3.23.0-rc.1", "3.23.0")).toBe(true);
    expect(isOlder("3.23.0-beta.1", "3.23.0")).toBe(true);
  });

  it("does not offer the candidate to a deck already on the release", () => {
    // The same bug read from the other side, and the worse-looking half: with
    // the old segmentation a deck on 3.23.0 saw 3.23.0-rc.1 as NEWER, so a
    // candidate left on `latest` would have been installed over the release by
    // decks that had already moved past it.
    expect(isOlder("3.23.0", "3.23.0-rc.1")).toBe(false);
  });

  it("keeps a candidate for a later release newer than the current one", () => {
    // The rule is a tie-break inside one release triple, not a demotion of
    // prereleases in general — 3.23.0-beta.1 really is newer than 3.22.15. A
    // blanket rule would tell a tester on `next` that nothing was available.
    expect(isOlder("3.22.15", "3.23.0-beta.1")).toBe(true);
  });

  it("orders successive candidates among themselves", () => {
    expect(isOlder("3.23.0-rc.1", "3.23.0-rc.2")).toBe(true);
    expect(isOlder("3.23.0-rc.2", "3.23.0-rc.1")).toBe(false);
  });
});
