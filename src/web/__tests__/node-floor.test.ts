// The Node floor is written in four places and checked in none of them.
//
// `engines.node` in package.json, a shields.io badge whose number lives inside
// a URL, a bullet under Requirements, and whatever the source comments say. All
// four are the same fact, and until this file none of them could disagree
// loudly. One already had: browser-history.mjs said "CI runs Node 22 on all
// three OSes and Node 18 on one Linux leg", and the matrix has never had a
// Node 18 leg — the sentence was written for a workflow edit that was never
// pushed, and it read as reassurance for a release and a half.
//
// WHAT THE FLOOR IS, MEASURED. `>=18` is not a guess. The tarball this repo
// publishes was packed, installed `--offline` into an empty package and booted
// through its own shim on Node 18.20.8 and on Node 20.20.2 (macOS, 2026-09-05):
// both printed the banner, registered the Claude Code hook into a sandboxed
// HOME, and answered `/`, `/api/health`, `/api/system` and `/api/version` with
// 200. So the claim is TRUE. It is simply not re-checked by anything that runs
// on its own.
//
// WHY THE FLOOR IS NOT RAISED TO WHAT CI RUNS. That was the obvious repair and
// the measurement above is what rules it out. `engines` is not documentation:
// npm prints EBADENGINE at install time for anything below it, so moving the
// floor to 22 would put a yellow warning block in front of every user on 18 or
// 20 — for a deck that works for them. A scary warning about a working install
// is a worse defect than the one being fixed.
//
// SO THE GAP IS REGISTERED INSTEAD. `KNOWN_GAP` below names the floor and the
// versions the matrix actually runs. Change either — bump `engines`, add a leg
// — and this file goes red until the register is updated to match, which is the
// moment somebody has to decide what the repo now promises. The pattern is
// skip-gates.mjs's, for the same reason: a fact that only lives in a comment is
// a fact nothing defends.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const read = (...parts: string[]) => readFileSync(join(REPO, ...parts), "utf8");

const pkg = JSON.parse(read("package.json"));
const readme = read("README.md");
const workflow = read(".github", "workflows", "publish.yml");

/** The declared floor, as a major version. `>=18` → 18. */
function declaredFloor(): number {
  const spec = String(pkg.engines?.node ?? "");
  const m = /^>=\s*(\d+)/.exec(spec);
  if (!m) throw new Error(`engines.node is "${spec}", which this file cannot read as a floor`);
  return Number(m[1]);
}

/** Every Node major the CI matrix actually installs, read off the workflow. */
function ciVersions(): number[] {
  const found = [...workflow.matchAll(/node-version:\s*(\[[^\]]*\]|\S+)/g)]
    .flatMap(m => [...m[1].matchAll(/\d+/g)].map(n => Number(n[0])));
  return [...new Set(found)].sort((a, b) => a - b);
}

/**
 * The gap between what is promised and what is exercised, stated once.
 *
 * `floor` is what `engines.node` says; `ci` is every Node major the matrix
 * installs. When the floor is one of them this register is satisfied trivially
 * and the case below says so. When it is not — today — the register is the
 * repo's written acknowledgement that a supported version is going untested,
 * with the reason, and this file fails the moment either number moves.
 */
const KNOWN_GAP = {
  floor: 18,
  ci: [22],
  why: "Node 18 and 20 are both past end of life and neither is a runner default any more, "
    + "so the matrix runs 22 only. The floor stays at 18 because the shipped tarball was "
    + "measured booting on 18 and 20, and raising it would print EBADENGINE at install "
    + "time for users the deck works fine for. Closing this properly means an extra leg "
    + "on the oldest supported version — see #773, which needs a token with `workflow` scope.",
} as const;

describe("the Node floor", () => {
  it("is spelled the same in the manifest, the badge and the requirements list", () => {
    // Three copies of one number, two of them inside strings that no tool
    // validates: the badge's is URL-encoded (`%3E%3D18` is `>=18`) and the
    // bullet's is prose with a `≥` in it. A bump that touches the manifest and
    // not these two leaves the README promising something the package does not.
    const floor = declaredFloor();
    const badge = /\[!\[Node\.js[^\]]*\]\(https:\/\/img\.shields\.io\/badge\/node-%3E%3D(\d+)-/.exec(readme);
    expect(badge, "the README lost its Node badge, or the badge changed shape").toBeTruthy();
    expect(Number(badge![1]), "the badge and engines.node disagree").toBe(floor);

    const bullet = /^- Node\.js ≥ (\d+) —/m.exec(readme);
    expect(bullet, "the Requirements list lost its Node bullet").toBeTruthy();
    expect(Number(bullet![1]), "the Requirements bullet and engines.node disagree").toBe(floor);
  });

  it("is never above what the matrix runs, which would be a leg testing nothing", () => {
    // The one direction that is always wrong, whatever the register says: a
    // matrix leg BELOW the floor runs a version the package refuses to install
    // on, so the leg is either green for the wrong reason or red forever.
    const floor = declaredFloor();
    const ci = ciVersions();
    expect(ci.length, "no node-version found in the workflow at all").toBeGreaterThan(0);
    for (const version of ci) {
      expect(version, `CI installs Node ${version}, below the declared floor of ${floor}`)
        .toBeGreaterThanOrEqual(floor);
    }
  });

  it("is either exercised by CI or written down here as not being", () => {
    const floor = declaredFloor();
    const ci = ciVersions();
    if (ci.includes(floor)) return; // nothing to register; the promise is tested.
    expect(KNOWN_GAP.floor, "the floor moved and the register did not").toBe(floor);
    expect([...KNOWN_GAP.ci], "the matrix changed and the register did not").toEqual(ci);
    expect(KNOWN_GAP.why.length, "a registered gap with no reason is a silent one")
      .toBeGreaterThan(80);
  });

  it("is not claimed by any source comment to be a CI leg it is not", () => {
    // The specific falsehood this file was written for. A comment may say
    // whatever it likes about Node versions — the sources are full of "measured
    // on Node 22.14" — but a sentence putting a version next to the word "leg"
    // is a claim about a file in this repo, and that one was wrong.
    //
    // The rule is deliberately blunt, and it fired on the first replacement
    // written for the comment it exists to police: prose SAYING a leg does not
    // exist trips it as readily as prose claiming one does. That is the right
    // trade at this size. A comment that has to discuss a leg the matrix does
    // not have should point at the register above instead of describing it,
    // which is what a reader needs anyway — the register is the thing that
    // stays true.
    const ci = ciVersions();
    for (const rel of ["src/server/browser-history.mjs", "src/server/codex-usage.mjs", "src/server/index.mjs"]) {
      const src = read(...rel.split("/"));
      for (const m of src.matchAll(/Node (\d+)[^.\n]{0,40}\bleg\b/g)) {
        expect(ci, `${rel} claims a Node ${m[1]} leg; the matrix runs ${ci.join(", ")}`)
          .toContain(Number(m[1]));
      }
    }
  });
});
