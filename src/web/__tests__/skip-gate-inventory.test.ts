// A skipped test and a passing test are both green, and this suite skips
// twenty-eight cases behind twenty-four gate sites. #525 knew that and put one
// assertion in CI to protect one of them: cc-project-slug.test.ts's drive-colon
// rule, which was gated on the platform NOT being Windows and so ran on exactly
// one leg of the matrix, where nobody would ever notice it going quiet. The
// step read vitest's JSON report, found that title, and failed unless it said
// `passed`.
//
// #585 audited every other gate against that same reasoning and came back with
// two findings the per-title step could not have seen.
//
// The first is that the protected case did not need its gate. `ccProjectSlug`
// is `resolve(cwd)` and then one `replace`, and only `resolve` differs by
// platform — so comparing the TAIL, the way the three sibling cases in that
// file already did, checks the drive-colon rule on Linux and macOS too. It is
// un-gated now. Which means the one title CI looked up is not skipped anywhere
// any more, and an assertion phrased as "this title must not be pending" would
// have gone on passing forever while protecting nothing.
//
// The second finding is the one that needed a mechanism rather than an edit.
// Nineteen of the gated cases are conditioned on `process.platform`, and a
// platform gate cannot lie: the case runs on exactly the legs the condition
// names. Six are conditioned on a RUNTIME PROBE — `hardLinksWork` at four
// sites, `readOnlyDirBlocksWrites` at one, and the presence of
// dist/web/index.html at one. Each of those asks the machine a question at
// import time and disappears if the answer changes, on all three legs at once,
// with a green matrix either side of it. The theme-first-paint one is the
// sharpest, because what satisfies it is a STEP IN THE WORKFLOW rather than a
// property of the filesystem: delete `npm run build` from publish.yml, rename
// vite's `build.outDir`, or move index.html, and the only assertion in the
// suite that reads the artifact that actually ships is gone without a word.
// Moving that artifact aside and running the file reports `12 passed | 1
// skipped`, and the file green.
//
// So the fix is not another named title. It is a register — skip-gates.mjs —
// stating every gate site and, as a function of `platform`, when each is
// expected to skip. CI compares the register against what vitest's report
// actually says, on every leg; this file compares the register against the test
// sources. That second half is what this file is for and it is the half that
// matters most: without it the register is only a comment, and a gate added
// tomorrow without a line in it would either be caught late by CI or — for a
// probe gate on a leg where nothing else changed — quietly widen the hole this
// issue is about.
//
// The scanner is a scanner, not a parser, so the cases below also pin its two
// blind spots deliberately: it must ignore a gate that a comment is only
// TALKING ABOUT (four files in this suite argue in prose about the construct
// they chose not to use), and it counts the cases inside a gated `describe` by
// reading the block, which is why the counts for the two `describe` gates are
// checked here rather than trusted.
//
// One consequence worth naming, because it looks like a trick: the fixture
// sources below are assembled through `gate()` rather than written out, so that
// this file's own examples are not picked up as real gates by the very scanner
// it is testing. Written literally, they would be — which is itself a small
// demonstration that the scanner sees what it claims to see.
//
// The workflow assertions at the bottom are the other end of the same rope. The
// register's expectation for the dist gate is "never skips", and the only
// reason that is true is the build step; the register's expectation for ubuntu
// and macOS is zero, and the only reason CI notices is that the step is no
// longer gated on `runner.os`. Both are facts about a YAML file, so they are
// read out of the YAML file rather than restated here.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// @ts-expect-error — .mjs register with no types, imported the way
// cc-project-slug.test.ts imports the .mjs server module. It is .mjs rather
// than .ts because the workflow step imports the very same file from plain
// node, with no transpiler in the path.
const registry = await import("./skip-gates.mjs");
const {
  CONDITIONS, GATES, PLATFORMS,
  auditReport, expectedSkips, group, registeredGates, scanSource, scanTestSources, skipsOn,
} = registry;

type Gate = { file: string; gate: string; condition: string; sites: number; cases: number };

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(repo, ...parts), "utf8");
const publishYml = () => read(".github", "workflows", "publish.yml");
const gates = () => GATES as Gate[];

// Assembles a gate's source text with the opening parenthesis supplied
// separately, so nothing in this file matches the scanner's own pattern. See
// the note in the header.
const gate = (kind: string, condition: string) => `${kind}${"("}${condition})`;

// The step that carries the check, sliced out by name so the assertions about
// it cannot be satisfied by some other step in the file.
const auditStep = () => {
  const yml = publishYml();
  const at = yml.indexOf("- name: Assert every gated case ran where it was supposed to");
  expect(at, "the step that asserts the gated cases ran has been renamed or removed").toBeGreaterThan(-1);
  const end = yml.indexOf("\n  # ", at);
  return end === -1 ? yml.slice(at) : yml.slice(at, end);
};

// A JSON report in the shape vitest writes, with `skipped` cases per file and
// the rest passing — enough of one for the audit, which only reads names and
// statuses.
const reportOf = (skipped: Record<string, number>, ran: string[] = []) => ({
  testResults: [
    ...Object.entries(skipped).map(([file, n]) => ({
      name: `/checkout/src/web/__tests__/${file}`,
      assertionResults: [
        ...Array.from({ length: n }, () => ({ status: "pending" })),
        { status: "passed" },
      ],
    })),
    ...ran.map((file) => ({
      name: `/checkout/src/web/__tests__/${file}`,
      assertionResults: [{ status: "passed" }],
    })),
  ],
});

describe("the register of conditionally-skipped cases", () => {
  it("lists exactly the gates the test sources contain, and nothing else", () => {
    // The load-bearing assertion of this file. `scanTestSources` reads the
    // DIRECTORY rather than a list, so a brand-new test file with a brand-new
    // gate in it is scanned the moment it lands — and lands here as a mismatch
    // until somebody writes down what it is expected to do on each platform.
    expect(scanTestSources()).toEqual(registeredGates());
  });

  it("gives every gate a condition whose answer is a function of the platform", () => {
    // Not "of the running platform". Nobody working on this repo has all three
    // operating systems, so every claim the register makes has to be checkable
    // from whichever one they do have — which means the conditions are pure
    // functions of a parameter rather than reads of `process.platform`.
    for (const g of gates()) {
      expect(Object.keys(CONDITIONS), `${g.file} gates on an unregistered condition`).toContain(g.condition);
      for (const platform of PLATFORMS) {
        expect(typeof skipsOn(g, platform), `${g.condition} on ${platform}`).toBe("boolean");
      }
    }
    // And every registered condition is one some gate actually uses: a leftover
    // entry here would let a deleted gate keep an expectation alive.
    expect(Object.keys(CONDITIONS).sort()).toEqual([...new Set(gates().map((g) => g.condition))].sort());
  });

  it("expects nothing at all to be skipped on Linux and on macOS", () => {
    // This is what un-gating the drive-colon case bought, and it is worth more
    // than the case itself: zero is the only expectation that cannot be
    // satisfied by accident. On these two legs CI does not have to work out
    // which gate a skip belongs to — any skip at all is a finding.
    expect(expectedSkips("linux")).toEqual({ total: 0, byFile: {} });
    expect(expectedSkips("darwin")).toEqual({ total: 0, byFile: {} });
  });

  it("expects the thirty-five platform-gated cases to skip on Windows, file by file", () => {
    // Twenty-six behind `process.platform === "win32"`, eight behind the posix
    // runIf family, and sound-hook-park's read-only-directory case, whose probe
    // reports false on Windows because chmod there toggles a read-only bit that
    // does not stop a write into the directory. Written out per file rather
    // than as a total, so a change that moves a case from one gate to another is
    // a mismatch rather than an arithmetic coincidence.
    expect(expectedSkips("win32")).toEqual({
      total: 35,
      byFile: {
        "codex-auth-rename-retry.test.ts": 1,
        "codex-auth-temp-collision.test.ts": 3,
        "exec-shim-callers.test.ts": 5,
        "exec-timeout.test.ts": 2,
        "exec-windows.test.ts": 3,
        "no-shell-hook-commands.test.ts": 2,
        "relay-guard.test.ts": 6,
        "settings-atomic-write.test.ts": 1,
        "settings-symlink-target.test.ts": 7,
        "sound-hook-park.test.ts": 1,
        "supervisor-exit.test.ts": 3,
        "uv-bootstrap-atomic.test.ts": 1,
      },
    });
  });

  it("expects the runtime-probe gates to run on every leg, which is the claim CI checks", () => {
    // The whole point of the issue. These are the ones that can go quiet
    // everywhere at once, so the register's expectation for them is the
    // strongest one available — they always run — and CI is what turns that
    // expectation into a failure on the day the machine disagrees.
    const always = gates().filter((g) => g.condition === "!hardLinksWork" || g.condition === "!existsSync(dist)");
    expect(always.reduce((n, g) => n + g.sites, 0)).toBe(4);
    for (const g of always) for (const platform of PLATFORMS) expect(skipsOn(g, platform)).toBe(false);

    // The sixth probe site is the read-only-directory one, the only probe with
    // a legitimate per-platform answer — and the reason it is stated here as a
    // function of platform is that it is not checkable any other way from macOS.
    const readOnly = gates().filter((g) => g.condition === "!readOnlyDirBlocksWrites");
    expect(readOnly).toHaveLength(1);
    expect(readOnly[0].sites).toBe(1);
    expect(skipsOn(readOnly[0], "win32")).toBe(true);
    expect(skipsOn(readOnly[0], "linux")).toBe(false);
    expect(skipsOn(readOnly[0], "darwin")).toBe(false);
  });

  it("has no gate left that hides a case from every leg but one", () => {
    // A case visible on exactly one runner is the shape that made #525
    // necessary, and there is none now. This is not a ban on ever adding one —
    // it is a place where somebody has to say out loud that they are.
    for (const g of gates()) {
      const legs = PLATFORMS.filter((p: string) => !skipsOn(g, p));
      expect(legs.length, `${g.file} (${g.condition}) runs on only ${legs.join(", ")}`).toBeGreaterThan(1);
    }
  });
});

describe("the scanner the register is checked against", () => {
  it("reads the condition out of a gate however it is spread across lines", () => {
    const src = [
      `${gate("it.skipIf", 'process.platform === "win32"')}("a", () => {});`,
      `${gate("it.skipIf", "\n  !hardLinksWork,\n")}(`,
      '  "b",',
      "  () => {},",
      ");",
      `${gate("test.runIf", "posix")}("c", () => {});`,
    ].join("\n");
    expect(scanSource("fake.test.ts", src)).toEqual([
      { file: "fake.test.ts", gate: "it.skipIf", condition: 'process.platform === "win32"', cases: 1 },
      { file: "fake.test.ts", gate: "it.skipIf", condition: "!hardLinksWork,", cases: 1 },
      { file: "fake.test.ts", gate: "test.runIf", condition: "posix", cases: 1 },
    ]);
  });

  it("does not count a gate that a comment is only talking about", () => {
    // cswap-argv-position, listen-port-fallback and system-metrics-locale all
    // name the construct they chose NOT to use, in prose, above the case that
    // does not use it. A scanner that counted those would report gates that do
    // not exist, and the register would have to lie to match.
    const src = [
      `// a ${gate("skipIf", 'process.platform !== "win32"')} here would make it invisible`,
      `// so ${gate("it.skipIf", "!hardLinksWork")} is deliberately not used`,
      `${gate("it.skipIf", "posix")}("real", () => {});`,
    ].join("\n");
    expect(scanSource("fake.test.ts", src).map((s: { condition: string }) => s.condition)).toEqual(["posix"]);
  });

  it("counts every case inside a gated describe, not the block as one", () => {
    // A gated `describe` takes a whole block off the leg, and the two in this
    // suite carry three cases each. Counting the block as one would understate
    // the Windows expectation by four, which is exactly the sort of quiet
    // arithmetic error the register exists to stop.
    const src = [
      `${gate("describe.skipIf", 'process.platform === "win32"')}("block", () => {`,
      '  it("one", () => {});',
      "  // it (in prose, mid-line) must not be counted",
      '  it("two", async () => {});',
      "});",
      'describe("after", () => {',
      '  it("not counted", () => {});',
      "});",
    ].join("\n");
    expect(scanSource("fake.test.ts", src)[0]).toEqual({
      file: "fake.test.ts",
      gate: "describe.skipIf",
      condition: 'process.platform === "win32"',
      cases: 2,
    });
  });

  it("makes an unregistered gate a mismatch rather than a silent addition", () => {
    // The mutation this whole file exists to catch, run against the scanner's
    // output rather than against the working tree, so it can live in the suite
    // permanently instead of being a thing somebody once tried by hand.
    const withOneMore = group([
      ...scanTestSources(),
      { file: "brand-new.test.ts", gate: "it.skipIf", condition: "!someNewProbe", cases: 1 },
    ]);
    expect(withOneMore).not.toEqual(registeredGates());
    expect(withOneMore.map((g: Gate) => g.file)).toContain("brand-new.test.ts");
  });
});

describe("what CI does with the register", () => {
  it("passes a report in which every registered case skipped exactly where it should", () => {
    // Windows: the full expected breakdown, and nothing else pending.
    expect(auditReport(reportOf(expectedSkips("win32").byFile), "win32"))
      .toMatchObject({ ok: true, problems: [] });
    // macOS and Linux: nothing skipped at all, which is the whole expectation.
    expect(auditReport(reportOf({}, ["theme-first-paint.test.ts"]), "darwin"))
      .toMatchObject({ ok: true, problems: [] });
    expect(auditReport(reportOf({}, ["theme-first-paint.test.ts"]), "linux"))
      .toMatchObject({ ok: true, problems: [] });
  });

  it("fails when a probe gate goes quiet on a leg where nothing should skip", () => {
    // The exact failure this issue is about, in report form: dist/web/index.html
    // is not there, theme-first-paint skips its one case, the file reports green
    // and so does the matrix. Under the audit it is a named error naming the
    // file and pointing at the register.
    const audit = auditReport(reportOf({ "theme-first-paint.test.ts": 1 }), "linux");
    expect(audit.ok).toBe(false);
    expect(audit.problems.join("\n")).toContain("theme-first-paint.test.ts");
    expect(audit.problems.join("\n")).toContain("skip-gates.mjs");
  });

  it("fails when a registered gate stops skipping without the register being told", () => {
    // The other direction, and the one the per-title step did cover for its
    // single title: a case the register says skips on this platform ran instead.
    // Worth failing on, because it usually means a condition moved rather than
    // that anybody intended the change.
    const byFile = { ...expectedSkips("win32").byFile, "supervisor-exit.test.ts": 0 };
    const audit = auditReport(reportOf(byFile), "win32");
    expect(audit.ok).toBe(false);
    expect(audit.problems.join("\n")).toContain("supervisor-exit.test.ts");
  });

  it("fails when a whole registered file is missing from the report", () => {
    // Deleting a gated file, or having it fail to collect at all, would
    // otherwise read as "nothing was skipped there" and pass.
    const byFile = { ...expectedSkips("win32").byFile };
    delete byFile["exec-shim-callers.test.ts"];
    expect(auditReport(reportOf(byFile), "win32").ok).toBe(false);
  });

  it("treats a report with no test files as a failure rather than as zero skips", () => {
    // An empty report satisfies "nothing was skipped" trivially, which is how a
    // check of this shape fails open. It is a failure.
    expect(auditReport({ testResults: [] }, "linux").ok).toBe(false);
    expect(auditReport({}, "linux").ok).toBe(false);
  });

  it("counts a todo as not having run, the same as a skip", () => {
    // There are none in this suite today. `it.todo` is the other way a case can
    // sit in the report without executing, and a guard that only knew about
    // `pending` would let one in.
    const audit = auditReport({
      testResults: [{
        name: "/checkout/src/web/__tests__/theme-first-paint.test.ts",
        assertionResults: [{ status: "passed" }, { status: "todo" }],
      }],
    }, "darwin");
    expect(audit.ok).toBe(false);
  });
});

describe("the workflow the register is enforced from", () => {
  it("states the win32 gate count this issue found stale, and states the true one", () => {
    // publish.yml said "17 sites" from #525 until #585. It was right when it was
    // written and wrong two releases later, when #532 deleted ccdeck-stub-exit
    // .test.ts and took two gates with it — and a number in a comment is the one
    // thing nobody re-checks. Read back out of the YAML and compared against the
    // register, so the comment cannot drift again without this going red.
    const win32Sites = gates()
      .filter((g) => g.condition === 'process.platform === "win32"')
      .reduce((n, g) => n + g.sites, 0);
    expect(win32Sites).toBe(16);

    const stated = publishYml().match(/the (\d+) sites gated `skipIf\(process\.platform === "win32"\)`/);
    expect(stated, "publish.yml no longer states the win32 gate count in the form this reads").not.toBeNull();
    expect(Number(stated![1])).toBe(win32Sites);

    const windows = publishYml().match(/— (\d+) skipped cases in all —/);
    expect(windows, "publish.yml no longer states the Windows skip total").not.toBeNull();
    expect(Number(windows![1])).toBe(expectedSkips("win32").total);
  });

  it("checks the report on every leg, not only on Windows", () => {
    // The original step carried `runner.os == 'Windows'`, because the one case
    // it knew about only ran there. The probe gates are the opposite shape: they
    // go quiet on all three legs at once, and ubuntu and macOS are where the
    // register expects zero — the strongest check available anywhere in that
    // workflow. A step gated back to Windows would silently drop both of those.
    const step = auditStep();
    expect(step).toContain("if: ${{ !cancelled() }}");
    expect(step).not.toContain("runner.os");
  });

  it("reads the register rather than restating its numbers in YAML", () => {
    // A count copied into the workflow is a second source of truth, and the "17"
    // is the demonstration of what happens to one. The step imports the register
    // and asks it, so there is nothing in the step to go stale.
    const step = auditStep();
    expect(step).toContain("src/web/__tests__/skip-gates.mjs");
    expect(step).toContain("auditReport");
    expect(step).toContain("process.platform");
    expect(step).not.toMatch(/\b(?:16|26|30|35)\b/);
  });

  it("builds the web bundle before it runs the suite, which is what one gate depends on", () => {
    // theme-first-paint.test.ts's gate is the presence of dist/web/index.html,
    // and the register answers "never skips" for it. That answer is true only
    // because of a step in this file, so the step is pinned here — otherwise the
    // register would be asserting something about the workflow that the workflow
    // had stopped doing. Three copies of one decision, and this is the seam
    // between two of them.
    const yml = publishYml();
    const jobs = yml.indexOf("jobs:");
    const build = yml.indexOf("- name: Build web bundle", jobs);
    const suite = yml.indexOf("- name: Run tests", jobs);
    expect(build).toBeGreaterThan(-1);
    expect(suite).toBeGreaterThan(build);
    expect(yml).toContain("run: npm run build");
    expect(read("vite.config.ts")).toContain('outDir: resolve(root, "dist/web")');
  });

  it("still writes the JSON report the step reads, at the path it reads it from", () => {
    // vitest resolves --outputFile against its own root, which vite.config.ts
    // sets to src/web — so the filename in the test step and the path in the
    // audit step are two halves of one fact, and neither file says the other.
    expect(publishYml()).toContain("--outputFile.json=vitest-report.json");
    expect(auditStep()).toContain("src/web/vitest-report.json");
    expect(read("vite.config.ts")).toContain('root: resolve(root, "src/web")');
  });
});
