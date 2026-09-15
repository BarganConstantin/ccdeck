// #961: the typecheck script existed, passed, and nothing ran it.
//
// WHAT WAS OBSERVED at 26e946b. `package.json` carried
// `"typecheck": "tsc --noEmit -p tsconfig.build.json"`, it exited 0 on a clean
// checkout, and `grep -c typecheck .github/workflows/publish.yml` answered `0`.
// The whole workflow was three jobs — the three-OS `test` matrix, `floor`, and
// `publish` — and not one of them invoked `tsc`.
//
// Why that is the half that matters rather than a tidy-up. `npm run build` is
// `vite build`, and Vite transpiles TypeScript with esbuild, which STRIPS types
// without checking them: a type error does not fail the build, it produces a
// working bundle. So a green matrix said nothing whatsoever about type
// correctness, and the `"strict": true` in tsconfig.json was enforced by
// whoever remembered to type the command before pushing. A type error could
// land on main and ship, and the first sign of it would be a runtime
// `undefined` on a user's machine.
//
// It is also the shape this repo already reasons about at length elsewhere.
// publish.yml's own comment on the skip-gate audit says a check that can
// quietly stop running is worse than no check, and the workflow was
// restructured so the gate is a real `needs:` rather than a red X beside a
// publish that proceeds anyway. A script nothing invokes is that same problem
// one step earlier: the check exists and nothing makes it run. So this file
// asserts the three facts that together make the guarantee hold for somebody
// other than the person who ran it locally — the script does what it says, a
// job runs it, and the release cannot go out around it — plus the one fact that
// stops it becoming vacuous, which is that `strict` is still on.
//
// READ AS TEXT, like every other assertion this repo makes about CI
// (publish-step-gating.test.ts says why: there is no YAML parser in the
// dependency tree, and the facts wanted here survive a line-oriented reading of
// a file whose jobs are all one indent apart). tsconfig.build.json is read as
// text too, and for a different reason: it carries `//` comments, so it is
// JSONC and `JSON.parse` refuses it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(repo, ...parts), "utf8");

const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
const workflow = read(".github", "workflows", "publish.yml");

/** The script that runs the type checker, found by what it DOES rather than by
 *  its name — a rename is allowed, dropping it is not, and this way the failure
 *  says which of the two happened. */
const typecheckScript = (): string => {
  const found = Object.entries(pkg.scripts).filter(([, cmd]) => /\btsc\b/.test(cmd));
  expect(
    found.map(([name]) => name),
    "no script in package.json runs `tsc` any more — the type check is gone, not merely renamed",
  ).toHaveLength(1);
  return found[0][0];
};

/** Every job in the workflow, name → body, sliced on the two-space indent that
 *  only a job key sits at. Comment lines at that indent start with `#` and so
 *  cannot be mistaken for one, and nothing inside a `run: |` block is indented
 *  shallowly enough to match. */
const jobs = (): Record<string, string> => {
  const at = workflow.indexOf("\njobs:\n");
  expect(at, "publish.yml no longer has a `jobs:` block").toBeGreaterThan(-1);
  const body = workflow.slice(at);
  const marker = /\n {2}([A-Za-z_][\w-]*):\n/g;
  const starts: { name: string; at: number }[] = [];
  for (const m of body.matchAll(marker)) starts.push({ name: m[1], at: m.index! });
  expect(starts.length, "no jobs found in publish.yml — the slicing above has stopped matching")
    .toBeGreaterThan(2);
  const out: Record<string, string> = {};
  starts.forEach((s, i) => {
    out[s.name] = body.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : undefined);
  });
  return out;
};

/** The jobs that run `npm run <script>` anywhere in them. */
const jobsRunning = (script: string) =>
  Object.entries(jobs())
    .filter(([, b]) => b.includes(`npm run ${script}`))
    .map(([name]) => name);

describe("the type check CI actually performs", () => {
  it("has a script that checks types without emitting, against the project that ships", () => {
    // Both halves matter. `--noEmit` is what makes it a check rather than a
    // second build, and `-p tsconfig.build.json` is what makes it readable:
    // tsc over the whole tree reported thousands of errors before the @types
    // packages landed, and the suite is still outside the project on purpose.
    const command = pkg.scripts[typecheckScript()];
    expect(command).toContain("--noEmit");
    expect(command, "the type check no longer names tsconfig.build.json, so what it covers is anyone's guess")
      .toContain("tsconfig.build.json");
  });

  it("is run by a job, which is the entire point of the issue", () => {
    // The assertion this file exists for. The script and the two missing
    // @types packages were most of the work and had already landed; what had
    // not landed was the step that makes the guarantee hold for anyone but the
    // person who ran it locally.
    const script = typecheckScript();
    expect(
      jobsRunning(script),
      `no job in publish.yml runs \`npm run ${script}\`. Vite strips types without checking them, so with no `
        + "job running tsc the matrix is green whatever the types say — which is exactly the state #961 found.",
    ).not.toHaveLength(0);
  });

  it("blocks the release, so a type error cannot be published around", () => {
    // A red X beside a publish that proceeds is not a gate; `needs:` is. The
    // job that runs the check has to be in the release's `needs:` list, and it
    // is checked by NAME rather than by counting, so moving the step into a
    // different job is fine as long as that job is the one gating the publish.
    const script = typecheckScript();
    const running = jobsRunning(script);
    const publish = jobs().publish;
    expect(publish, "publish.yml no longer has a `publish` job").toBeTruthy();
    const needs = /\n {4}needs: \[([^\]]*)\]/.exec(publish);
    expect(needs, "the publish job's `needs:` is no longer a flow-sequence this can read").not.toBeNull();
    const gates = needs![1].split(",").map((s) => s.trim());
    expect(
      running.some((job) => gates.includes(job)),
      `the publish job needs [${gates.join(", ")}], none of which runs \`npm run ${script}\` — so a type error `
        + "stops nothing and a release can go out over it",
    ).toBe(true);
  });

  it("is not a job that reports its own failure as a pass", () => {
    // `continue-on-error` and a trailing `|| true` are the two ways to keep a
    // check in the file while taking its teeth out, and both leave the workflow
    // looking as though the check is still there.
    const script = typecheckScript();
    for (const name of jobsRunning(script)) {
      const body = jobs()[name];
      expect(body, `the ${name} job is continue-on-error, so its verdict changes nothing`)
        .not.toMatch(/continue-on-error:\s*true/);
      expect(body, `the ${name} job swallows the type checker's exit code`)
        .not.toMatch(new RegExp(`npm run ${script}[^\\n]*\\|\\|`));
    }
  });
});

describe("what makes the check worth running", () => {
  it("still has strict on, without which the job proves almost nothing", () => {
    // A typecheck job over a non-strict config passes on code full of implicit
    // `any`. The job and the flag are two halves of one guarantee and neither
    // file mentions the other, so the seam is pinned here.
    expect(read("tsconfig.json"), 'tsconfig.json no longer sets "strict": true')
      .toMatch(/"strict":\s*true/);
    expect(read("tsconfig.build.json"), "tsconfig.build.json no longer extends the strict base config")
      .toMatch(/"extends":\s*"\.\/tsconfig\.json"/);
  });

  it("states what it covers, so the narrow project file reads as a choice", () => {
    // #961 asked for this explicitly. `tsconfig.build.json` covers `src/web`
    // minus the suite, and vite.config.ts is outside it too — which is
    // defensible (the tests are checked by being run, the build file by the
    // build working) but is easy to mistake for a leftover workaround from
    // before the @types packages landed. The scope is asserted so that widening
    // or narrowing it is a deliberate edit here rather than a side effect.
    const build = read("tsconfig.build.json");
    expect(build).toMatch(/"include":\s*\["src\/web"\]/);
    expect(build).toMatch(/"exclude":\s*\["src\/web\/__tests__"\]/);
    // And the reason is written down in the file itself rather than only here:
    // a scope with no stated reason is the thing that gets "tidied" later.
    expect(build.length, "tsconfig.build.json lost the comments explaining what it deliberately leaves out")
      .toBeGreaterThan(600);
  });
});
