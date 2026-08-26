// #623: what the trailing steps of the `publish` job are allowed to run after.
//
// A step's `if:` defaults to `success()`, and GitHub adds that default only
// when the expression mentions none of the four status functions. Write one —
// `!cancelled()` — and the implicit `success()` is REPLACED rather than joined,
// so the step runs after any earlier failure in the job. Three steps carried a
// bare `!cancelled()`: both alias publishes and the summary.
//
// The intent behind them is right and is stated in the workflow: the three
// publishes want to be independent of EACH OTHER, so one failing token or one
// registry hiccup does not leave the remaining names behind. What `!cancelled()`
// cannot express is the other half — that all three depend on everything
// UPSTREAM of them. The two read the same on a failed sibling and opposite on a
// failed preamble, which is the case that mattered:
//
//   · `Verify tag matches package.json` aborts on a 1.1.0 tag over a 1.0.x
//     package.json — the guard the workflow header advertises. `Publish
//     (ccdeck)` was skipped by its implicit success(); both aliases ran.
//   · `Build web bundle` fails once for a reason that does not reproduce — a
//     runner OOM, an ENOSPC. `ccdeck` was skipped; both aliases ran, rebuilt
//     through `prepublishOnly`, and published. That is exactly the split the
//     "ccdeck goes FIRST" ordering exists to prevent, arranged by the `if:`
//     conditions whenever the failure is upstream rather than downstream.
//   · `Summary` read nothing and asserted nothing, so it announced a release
//     and three npmjs links on a run that published none of them.
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

// The three names, and the step id each publish step is expected to carry so
// the summary can ask how it went.
const NAMES: [step: string, id: string][] = [
  ["Publish to npm (ccdeck)", "publish_ccdeck"],
  ["Publish to npm (agents-deck)", "publish_agents_deck"],
  ["Publish to npm (agent-dag", "publish_agent_dag"],
];

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

  it("puts the tag guard and the build in front of all three names, not only the first", () => {
    // `Publish (ccdeck)` was the only one of the three that kept the implicit
    // success(), so the guard the workflow header advertises protected exactly
    // one of the names it publishes. What stopped the other two from actually
    // reaching the registry was that `npm ci` had been skipped as well and
    // `prepublishOnly` died on `vite: command not found` — an accidental
    // barrier, in another file, standing where the guard is supposed to be.
    const build = stepNamed("Build web bundle");
    expect(
      build.body,
      "the release's build step has no `id:`, so nothing downstream can name its outcome and the publish "
        + "conditions have nothing to depend on",
    ).toMatch(/\n {8}id: build\n/);

    for (const [name] of NAMES) {
      const step = stepNamed(name);
      expect(
        gatedOnThePreamble(conditionOf(step)),
        `"${step.name}" can run when the build did not succeed. A build that fails once and would have `
          + "succeeded on a retry then publishes the aliases and not ccdeck — the exact split the \"ccdeck goes "
          + "FIRST\" ordering exists to prevent — and a tag/version mismatch stops being an abort.",
      ).toBe(true);
    }

    const summary = stepNamed("Summary");
    expect(
      gatedOnThePreamble(conditionOf(summary)),
      "the Summary step can run when the build did not succeed, so a run that published nothing still writes a "
        + "release announcement into the run summary — the first thing anybody looks at",
    ).toBe(true);
  });

  it("still lets one name fail without stopping the next", () => {
    // The other half, and the reason the fix is a longer condition rather than
    // deleting the `if:` outright. Each publish step is idempotent — it skips a
    // version already on the registry — so a re-run after a token or registry
    // problem must be able to reach the names that did not make it through.
    for (const [name] of NAMES.slice(1)) {
      const condition = conditionOf(stepNamed(name));
      expect(
        condition,
        `"${name}" no longer carries !cancelled(), so a failed sibling publish now stops it and a partial `
          + "release can no longer be finished by re-running the job",
      ).toContain("!cancelled()");
    }
    expect(
      conditionOf(stepNamed("Summary")),
      "the Summary step no longer carries !cancelled(), so the run that most needs a summary — the one where a "
        + "name failed — is the one that gets none",
    ).toContain("!cancelled()");
  });

  it("keeps the guard and the install upstream of the build whose outcome stands for them", () => {
    // The condition names one step, and that step's outcome is only worth
    // naming because everything the release has to be sure of happens before
    // it. Hoist `Install dependencies` above `Verify tag matches package.json`
    // — a natural-looking tidy-up, since the publish steps call `npm view` and
    // want npm set up anyway — and the guard stops being covered by anything.
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
    for (const [name] of NAMES) {
      expect(order.indexOf(stepNamed(name).name), `"${name}" now runs before the build it depends on`)
        .toBeGreaterThan(build);
    }
  });
});

describe("what the release job reports", () => {
  it("reads the outcome of each publish rather than announcing all three", () => {
    // The summary used to be the one step in this job that could not fail and
    // could not tell the truth: it re-read the version out of package.json and
    // printed three npmjs links, whatever had happened above it. On the
    // tag-mismatch run that is "### Published v1.44.0 🚀" with three links,
    // none of which resolve, under a red job.
    const summary = stepNamed("Summary");
    for (const [name, id] of NAMES) {
      expect(
        summary.body,
        `the Summary step does not read steps.${id}.outcome, so it cannot say whether ${name} landed`,
      ).toContain(`steps.${id}.outcome`);
      expect(
        stepNamed(name).body,
        `"${name}" has no \`id: ${id}\`, so the outcome the Summary reads for it is empty and every release `
          + "reads as a partial one",
      ).toMatch(new RegExp(`\\n {8}id: ${id}\\n`));
    }
  });

  it("says so when a name did not make it, instead of linking to a page that 404s", () => {
    const summary = stepNamed("Summary");
    // The three names are still the three names, and each is still reachable
    // from the summary — the fix is about what is claimed, not about dropping
    // the links.
    for (const pkg of ["ccdeck", "agents-deck", "agent-dag"]) {
      expect(summary.body, `the Summary step no longer mentions ${pkg}`).toContain(pkg);
    }
    expect(
      summary.body,
      "the Summary step has only one headline again, so a partial release is announced in the same words as a "
        + "complete one",
    ).toMatch(/### Partial release/);
    expect(summary.body).toMatch(/### Published v\$VERSION/);
  });
});
