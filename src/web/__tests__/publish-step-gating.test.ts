// #623: what the trailing steps of the `publish` job are allowed to run after.
//
// A step's `if:` defaults to `success()`, and GitHub adds that default only
// when the expression mentions none of the four status functions. Write one —
// `!cancelled()` — and the implicit `success()` is REPLACED rather than joined,
// so the step runs after any earlier failure in the job. Three steps carried a
// bare `!cancelled()`: two alias publishes and the summary.
//
// The aliases are gone — ccdeck is the only name published — but the summary
// keeps its `!cancelled()`, and on purpose: a run whose publish failed is the
// run that most needs one. What `!cancelled()` alone cannot express is that the
// summary still depends on everything UPSTREAM of it:
//
//   · `Verify tag matches package.json` aborts on a 1.1.0 tag over a 1.0.x
//     package.json — the guard the workflow header advertises.
//   · `Build web bundle` fails once for a reason that does not reproduce — a
//     runner OOM, an ENOSPC.
//   · `Summary` read nothing and asserted nothing, so it announced a release on
//     a run that published nothing.
//
// Nothing in the suite read those conditions. `skip-gate-inventory.test.ts`
// reads this same file and pins the audit step's `if:` — where `!cancelled()`
// is the right answer, because a red suite is exactly when you still want to
// know whether the gated cases ran. That is why the assertions below are scoped
// to the `publish` job: the construct is not wrong, its placement was.
//
// Read as text, like every other assertion this repo makes about CI. There is
// no YAML parser in the dependency tree and the facts wanted here — which step
// carries which condition, and in what order the steps appear — survive a
// line-oriented reading of a file whose steps are all one indent apart.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const publishYml = () => readFileSync(join(repo, ".github", "workflows", "publish.yml"), "utf8");

// The release job alone. The `test` job above it carries a deliberate
// `!cancelled()` of its own, and sweeping the whole file would either flag that
// one or force this file to special-case it by name.
const publishJob = () => {
  const yml = publishYml();
  const at = yml.indexOf("\n  publish:\n");
  expect(at, "publish.yml no longer has a `publish:` job to read").toBeGreaterThan(-1);
  return yml.slice(at);
};

type Step = { name: string; body: string; at: number };

// Every step in the release job, sliced on the `- name:` lines. Each step's
// keys are indented one level deeper than its own dash, so a step's block runs
// to the next dash and nothing inside a `run: |` script can start one.
const publishSteps = (): Step[] => {
  const job = publishJob();
  const marker = "\n      - name: ";
  const steps: Step[] = [];
  for (let at = job.indexOf(marker); at !== -1; at = job.indexOf(marker, at + 1)) {
    const next = job.indexOf(marker, at + 1);
    const body = next === -1 ? job.slice(at) : job.slice(at, next);
    steps.push({ name: body.slice(marker.length, body.indexOf("\n", marker.length)).trim(), body, at });
  }
  expect(steps.length, "no steps found in the publish job — the slicing above has stopped matching").toBeGreaterThan(4);
  return steps;
};

const stepNamed = (needle: string): Step => {
  const found = publishSteps().find((s) => s.name.startsWith(needle));
  expect(found, `no step in the publish job is named "${needle}" any more`).toBeDefined();
  return found!;
};

/** A step's `if:` expression, or null when it has none and so carries the
 *  implicit `success()`. */
const conditionOf = (step: Step): string | null => {
  const found = step.body.match(/\n {8}if: (.*)/);
  return found ? found[1].trim() : null;
};

/** Does this condition stop the step when the preamble did not succeed? Either
 *  answer is acceptable: no `if:` at all leaves the implicit `success()`, and
 *  an explicit one has to name the build's outcome. */
const gatedOnThePreamble = (condition: string | null) =>
  condition === null || /steps\.build\.outcome\s*==\s*'success'/.test(condition);

// The one publish step, and the id the summary reads its outcome by.
const PUBLISH = "Publish to npm (ccdeck)";
const PUBLISH_ID = "publish_ccdeck";

describe("what the release job's trailing steps may run after", () => {
  it("gates nothing in the release on !cancelled() alone", () => {
    // The defect in one line. A status function in an `if:` replaces the
    // implicit success() rather than joining it, so a condition that names a
    // status function and nothing else opens the step to every earlier failure
    // in the job — the tag/version guard and the build included.
    for (const step of publishSteps()) {
      const condition = conditionOf(step);
      if (condition === null || !condition.includes("cancelled()")) continue;
      expect(
        gatedOnThePreamble(condition),
        `"${step.name}" is gated on ` + condition + " — a status function in an `if:` REPLACES the implicit "
          + "success() rather than joining it, so this step runs after ANY earlier failure in the job, including "
          + "the tag/version guard and the build. It has to name what it depends on: steps.build.outcome == 'success'.",
      ).toBe(true);
    }
  });

  it("puts the tag guard and the build in front of the publish and the summary", () => {
    const build = stepNamed("Build web bundle");
    expect(
      build.body,
      "the release's build step has no `id:`, so nothing downstream can name its outcome and the summary's "
        + "condition has nothing to depend on",
    ).toMatch(/\n {8}id: build\n/);

    expect(
      gatedOnThePreamble(conditionOf(stepNamed(PUBLISH))),
      "the publish step can run when the build did not succeed, so a tag/version mismatch stops being an abort",
    ).toBe(true);

    expect(
      gatedOnThePreamble(conditionOf(stepNamed("Summary"))),
      "the Summary step can run when the build did not succeed, so a run that published nothing still writes a "
        + "release announcement into the run summary — the first thing anybody looks at",
    ).toBe(true);
  });

  it("still writes a summary for a run whose publish failed", () => {
    // The reason the summary has a longer condition rather than none: without
    // !cancelled() a failed publish would skip it, and that run is the one that
    // needs a summary most.
    expect(
      conditionOf(stepNamed("Summary")),
      "the Summary step no longer carries !cancelled(), so the run that most needs a summary — the one where the "
        + "publish failed — is the one that gets none",
    ).toContain("!cancelled()");
  });

  it("keeps the guard and the install upstream of the build whose outcome stands for them", () => {
    // The condition names one step, and that step's outcome is only worth
    // naming because everything the release has to be sure of happens before
    // it. Hoist `Install dependencies` above `Verify tag matches package.json`
    // — a natural-looking tidy-up, since the publish step calls `npm view` and
    // wants npm set up anyway — and the guard stops being covered by anything.
    const order = publishSteps().map((s) => s.name);
    const guard = order.indexOf("Verify tag matches package.json");
    const install = order.indexOf("Install dependencies");
    const build = order.indexOf("Build web bundle");
    expect(guard, "the tag/version guard has been renamed or removed").toBeGreaterThan(-1);
    expect(install, "the install step has been renamed or removed").toBeGreaterThan(-1);
    expect(
      build,
      "the build step is no longer after the tag guard, so steps.build.outcome no longer stands for the guard "
        + "having passed and a mismatched tag can publish again",
    ).toBeGreaterThan(guard);
    expect(build, "the build step is no longer after the install step").toBeGreaterThan(install);
    expect(order.indexOf(stepNamed(PUBLISH).name), "the publish now runs before the build it depends on")
      .toBeGreaterThan(build);
  });
});

describe("what the release job reports", () => {
  it("reads the outcome of the publish rather than announcing it", () => {
    // The summary used to be the one step in this job that could not fail and
    // could not tell the truth: it re-read the version out of package.json and
    // printed npmjs links, whatever had happened above it. On the tag-mismatch
    // run that is "### Published v1.44.0 🚀" over links that 404, under a red
    // job.
    expect(
      stepNamed("Summary").body,
      `the Summary step does not read steps.${PUBLISH_ID}.outcome, so it cannot say whether ccdeck landed`,
    ).toContain(`steps.${PUBLISH_ID}.outcome`);
    expect(
      stepNamed(PUBLISH).body,
      `the publish step has no \`id: ${PUBLISH_ID}\`, so the outcome the Summary reads is empty and every release `
        + "reads as a failed one",
    ).toMatch(new RegExp(`\\n {8}id: ${PUBLISH_ID}\\n`));
  });

  it("says so when the publish did not make it, instead of linking to a page that 404s", () => {
    const summary = stepNamed("Summary");
    expect(summary.body).toMatch(/### Published v\$VERSION/);
    expect(
      summary.body,
      "the Summary step has only one headline again, so a failed release is announced in the same words as one "
        + "that landed",
    ).toMatch(/### v\$VERSION was not published/);
  });
});
