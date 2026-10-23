// Only main is released.
//
// A `v*.*.*` tag can be pushed on any commit, and a manual run of this
// workflow can be started from any branch. Both used to reach `npm publish`
// and the GitHub release with whatever that commit held: a release branch
// tagged before its merge, a hotfix branch, a commit no pull request ever
// reached. Nothing in the workflow asked whether the commit was main's.
//
// Two changes, and this file holds both in place:
//   · the publish job starts on a manual run only from main; a tag starts it
//     as before;
//   · the on-main job asks git whether the commit is one of main's own
//     commits — on main's first-parent line, not merely in its history — and
//     every job that publishes or signs waits for its answer.
//
// Read as text, like every other assertion this repo makes about CI. The job
// conditions are not only read but evaluated: a small model of the part of
// GitHub's expression language the jobs use runs each condition against the
// events this workflow starts on, with the rule GitHub applies to a condition
// that names no status function — an implicit `success()`, so a job whose
// `needs:` did not all succeed does not start. And the check's git commands
// are run, as the step writes them, against a scratch repository whose main
// has merged a release branch with a merge commit.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workflow = readFileSync(join(repo, ".github", "workflows", "publish.yml"), "utf8");

/** Every job, id → body, sliced on the two-space indent only a job key sits
 *  at, as ci-typecheck.test.ts slices them. */
const jobs = (): Record<string, string> => {
  const at = workflow.indexOf("\njobs:\n");
  expect(at, "publish.yml no longer has a `jobs:` block").toBeGreaterThan(-1);
  const body = workflow.slice(at);
  const starts = [...body.matchAll(/\n {2}([A-Za-z_][\w-]*):\n/g)].map((m) => ({ id: m[1], at: m.index! }));
  expect(starts.length, "no jobs found in publish.yml — the slicing has stopped matching").toBeGreaterThan(2);
  const out: Record<string, string> = {};
  starts.forEach((s, i) => { out[s.id] = body.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : undefined); });
  return out;
};

const job = (id: string): string => {
  const body = jobs()[id];
  expect(body, `publish.yml has no \`${id}:\` job`).toBeDefined();
  return body;
};

/** A job's `needs:`, one id or a flow sequence. */
const needsOf = (id: string): string[] => {
  const m = /\n {4}needs: (.*)\n/.exec(job(id));
  if (!m) return [];
  const v = m[1].trim();
  return v.startsWith("[") ? v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean) : [v];
};

/** Every job a job waits for, directly or through the jobs it needs. */
const upstream = (id: string, seen = new Set<string>()): Set<string> => {
  for (const n of needsOf(id)) if (!seen.has(n)) { seen.add(n); upstream(n, seen); }
  return seen;
};

/** The job's own `if:` — four spaces in, so never a step's — or null. */
const jobCondition = (id: string): string | null => /\n {4}if: (.*)\n/.exec(job(id))?.[1].trim() ?? null;

type Step = { name: string; body: string };

const stepsOf = (id: string): Step[] => {
  const text = job(id);
  const marker = "\n      - name: ";
  const steps: Step[] = [];
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1)) {
    const next = text.indexOf(marker, at + 1);
    const body = next === -1 ? text.slice(at) : text.slice(at, next);
    steps.push({ name: body.slice(marker.length, body.indexOf("\n", marker.length)).trim(), body });
  }
  return steps;
};

const step = (id: string, name: string): Step => {
  const found = stepsOf(id).find((s) => s.name === name);
  expect(found, `no step in the ${id} job is named "${name}"`).toBeDefined();
  return found!;
};

// ── GitHub's expression language, the part these conditions use ─────────────

type Run = { event: string; ref: string; results: Record<string, string> };
type Value = string | boolean;

const STATUS = /\b(success|failure|cancelled|always)\(\)/;

/** Evaluates a job's `if:` for one run. String comparison ignores case, as
 *  GitHub's does. A condition naming no status function gets the implicit
 *  `success()`. Anything outside the modelled subset throws, so a condition
 *  that grows a new context fails here rather than being guessed at. */
function evaluate(expression: string, run: Run, needs: string[]): boolean {
  let src = expression.trim();
  if (src.startsWith("${{") && src.endsWith("}}")) src = src.slice(3, -2);
  const tokens = src.match(/'[^']*'|==|!=|&&|\|\||[!(),]|[A-Za-z_][\w.-]*|\S/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const take = (want?: string) => {
    const t = tokens[i++];
    if (t === undefined || (want !== undefined && t !== want)) throw new Error(`expected ${want ?? "more"} in ${expression}`);
    return t;
  };
  const truthy = (v: Value) => v !== false && v !== "";
  const fold = (v: Value) => (typeof v === "string" ? v.toLowerCase() : v);
  const status: Record<string, () => boolean> = {
    success: () => needs.every((n) => run.results[n] === "success"),
    failure: () => needs.some((n) => run.results[n] === "failure"),
    cancelled: () => false,
    always: () => true,
  };
  const primary = (): Value => {
    const t = take();
    if (t === "(") { const v = or(); take(")"); return v; }
    if (t.startsWith("'")) return t.slice(1, -1);
    if (peek() === "(") {
      take("(");
      const args: Value[] = [];
      while (peek() !== ")") { args.push(or()); if (peek() === ",") take(","); }
      take(")");
      if (t === "startsWith") return String(fold(args[0])).startsWith(String(fold(args[1])));
      if (t in status) return status[t]();
      throw new Error(`the model has no ${t}() (in ${expression})`);
    }
    if (t === "github.ref") return run.ref;
    if (t === "github.event_name") return run.event;
    const need = /^needs\.([\w-]+)\.result$/.exec(t);
    if (need) {
      if (!needs.includes(need[1])) throw new Error(`${t} names a job this one does not need (in ${expression})`);
      return run.results[need[1]];
    }
    throw new Error(`the model has no ${t} (in ${expression})`);
  };
  const unary = (): Value => (peek() === "!" ? (take(), !truthy(unary())) : primary());
  const eq = (): Value => {
    let v = unary();
    while (peek() === "==" || peek() === "!=") {
      const op = take();
      const r = unary();
      v = op === "==" ? fold(v) === fold(r) : fold(v) !== fold(r);
    }
    return v;
  };
  const and = (): Value => { let v = eq(); while (peek() === "&&") { take(); const r = eq(); v = truthy(v) && truthy(r); } return v; };
  const or = (): Value => { let v = and(); while (peek() === "||") { take(); const r = and(); v = truthy(v) || truthy(r); } return v; };
  const value = or();
  if (i !== tokens.length) throw new Error(`unread input in ${expression}`);
  return STATUS.test(src) ? truthy(value) : status.success() && truthy(value);
}

type Scenario = { event: string; ref: string; onMain?: "success" | "failure" };

/** The jobs one run starts. A job is decided once every job it needs is; it
 *  starts when its condition holds, and a job that starts succeeds — except
 *  on-main, which answers as the scenario says its commit is. */
function started(s: Scenario): Set<string> {
  const pending = Object.keys(jobs());
  const results: Record<string, string> = {};
  const out = new Set<string>();
  while (pending.length > 0) {
    const at = pending.findIndex((id) => needsOf(id).every((n) => n in results));
    expect(at, `the jobs [${pending.join(", ")}] need a job that does not exist, or each other`).toBeGreaterThan(-1);
    const [id] = pending.splice(at, 1);
    const go = evaluate(jobCondition(id) ?? "success()", { event: s.event, ref: s.ref, results }, needsOf(id));
    results[id] = !go ? "skipped" : id === "on-main" ? (s.onMain ?? "success") : "success";
    if (go) out.add(id);
  }
  return out;
}

const TAG = "refs/tags/v3.47.0";
const RC_TAG = "refs/tags/v3.47.0-rc.1";
const OTHER_BRANCHES = ["refs/heads/release/v3.47.0", "refs/heads/fix/a-hotfix", "refs/heads/feat/anything"];
/** The jobs that put something where users get it, or sign it as ccdeck's. */
const RELEASING = ["publish", "desktop", "desktop-release"];

describe("who may start the publish job", () => {
  it("starts it on a manual run only from main", () => {
    // Its own condition, alone: with every job it needs green, a manual run
    // from any other branch still does not start it.
    const condition = jobCondition("publish");
    expect(condition, "the publish job has no `if:` and so starts on every event").not.toBeNull();
    const allGreen = Object.fromEntries(needsOf("publish").map((n) => [n, "success"]));
    for (const ref of OTHER_BRANCHES) {
      expect(
        evaluate(condition!, { event: "workflow_dispatch", ref, results: allGreen }, needsOf("publish")),
        `a manual run from ${ref} starts the publish job, which publishes that branch's code to npm`,
      ).toBe(false);
    }
    // The legitimate ways in still work: a tag, and a manual run from main —
    // the retry after a registry outage that the trigger's comment names.
    for (const run of [
      { event: "push", ref: TAG },
      { event: "workflow_dispatch", ref: "refs/heads/main" },
      { event: "workflow_dispatch", ref: TAG },
    ]) {
      expect(evaluate(condition!, { ...run, results: allGreen }, needsOf("publish")), `${run.event} ${run.ref}`).toBe(true);
    }
  });

  it("publishes nothing on a manual run from another branch", () => {
    for (const ref of OTHER_BRANCHES) {
      const jobsStarted = started({ event: "workflow_dispatch", ref });
      expect(jobsStarted.has("publish"), `a manual run from ${ref} reaches npm publish`).toBe(false);
      expect(jobsStarted.has("desktop-release"), `a manual run from ${ref} makes a GitHub release`).toBe(false);
    }
  });
});

describe("only a commit that is on main is released", () => {
  it("makes every job that publishes or signs wait for on-main", () => {
    // Found by what a job does, not by name, so a job added later that
    // publishes or signs without waiting is caught here too. Comments are
    // left out: the floor job's mentions `npm publish` and runs none.
    const does = (body: string) => body.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    const releasing = Object.entries(jobs())
      .filter(([, body]) => /npm publish|gh release|secrets\.CCDECK_UPDATE_KEY|id-token: write|contents: write/.test(does(body)))
      .map(([id]) => id);
    expect(releasing).toEqual(expect.arrayContaining(RELEASING));
    for (const id of releasing) {
      expect(
        [...upstream(id)],
        `the ${id} job publishes or signs without waiting for on-main, so a commit that is not on main can reach it`,
      ).toContain("on-main");
    }
  });

  it.each([TAG, RC_TAG])("publishes and signs nothing for %s when its commit is not on main", (ref) => {
    for (const event of ["push", "workflow_dispatch"]) {
      const jobsStarted = started({ event, ref, onMain: "failure" });
      for (const id of RELEASING) {
        expect(jobsStarted.has(id), `${event} ${ref}: the ${id} job starts for a commit that is not on main`).toBe(false);
      }
      expect(jobsStarted.has("on-main"), `on-main does not run for ${event} ${ref}`).toBe(true);
    }
  });

  it("releases a tag on main, and a manual run from main, as before", () => {
    const tag = started({ event: "push", ref: TAG, onMain: "success" });
    for (const id of RELEASING) expect(tag.has(id), `a tag on main no longer starts the ${id} job`).toBe(true);
    expect(started({ event: "workflow_dispatch", ref: "refs/heads/main", onMain: "success" }).has("publish")).toBe(true);
  });

  it("asks before the test matrix, with nothing to wait for", () => {
    // The desktop build waits for on-main on every tag; with a `needs:` here
    // it would wait for the whole matrix too, and a refused tag would be
    // refused only after it.
    expect(needsOf("on-main")).toEqual([]);
  });
});

/** The check's `run: |` block, dedented: the script the runner hands to bash. */
const checkScript = (): string[] => {
  const lines = step("on-main", "Refuse a commit that is not on main").body.split("\n");
  const at = lines.findIndex((l) => l === "        run: |");
  expect(at, "the check no longer has a `run: |` block").toBeGreaterThan(-1);
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body;
};

// The check's three lines, as this file expects to find them. The git
// commands in them are run below exactly as written here.
const FETCH = "git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main";
const PEEL = /^commit=\$\(git (rev-parse [^)]*)\)$/;
const ASK = /^if git (rev-list [^|]*?) \| grep -xF "\$commit" > \/dev\/null; then$/;

describe("the question on-main asks", () => {
  it("lists main's own commits, from the whole history, and looks for the run's commit among them", () => {
    // A shallow clone cannot list main's line: it has one commit.
    expect(step("on-main", "Checkout").body).toMatch(/\n {10}fetch-depth: 0\n/);
    const script = checkScript();
    const fetch = script.indexOf(FETCH);
    const peel = script.findIndex((l) => PEEL.test(l));
    const ask = script.findIndex((l) => ASK.test(l));
    expect(fetch, "the check no longer fetches main itself").toBeGreaterThan(-1);
    expect(peel, "the check no longer peels the run's SHA to the commit it names").toBeGreaterThan(fetch);
    expect(ask, "the check no longer looks for the commit on a list of main's commits").toBeGreaterThan(peel);
    expect(ASK.exec(script[ask])![1], "the list is no longer main's first-parent line").toBe("rev-list --first-parent origin/main");
    expect(script.slice(ask).join("\n"), "a commit that is not on main no longer fails the check").toMatch(/\n\s+exit 1(\n|$)/);
    // Ancestry is the question this replaced, and the wrong one: the case
    // below is a commit in main's history that must not be released.
    expect(script.join("\n")).not.toMatch(/merge-base|--is-ancestor/);
  });

  it("refuses a branch commit tagged before its merge, even once a merge commit has brought it into main's history", () => {
    // main: a1 - a2 - a3 - M - a4, where M merges release/v9.1.0 (a2 - r1)
    // with a merge commit, and r1 was tagged before that merge. b1 sits on a
    // branch that was never merged.
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-on-main-"));
    try {
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
      // No user or system config: a signing or hook setting there is not this test's.
      Object.assign(env, {
        HOME: dir, XDG_CONFIG_HOME: dir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(dir, "no-global-config"),
        GIT_AUTHOR_NAME: "ci", GIT_AUTHOR_EMAIL: "ci", GIT_COMMITTER_NAME: "ci", GIT_COMMITTER_EMAIL: "ci",
      });
      const repo = join(dir, "repo");
      mkdirSync(repo);
      const git = (args: string[], input?: string) => {
        const r = spawnSync("git", args, { cwd: repo, env, input, encoding: "utf8" });
        return { status: r.status, out: (r.stdout ?? "").trim() };
      };
      const ok = (args: string[], input?: string) => {
        const r = git(args, input);
        expect(r.status, `git ${args.join(" ")}`).toBe(0);
        return r.out;
      };
      ok(["init", "-q"]);
      const tree = ok(["mktree"], "");
      const commit = (msg: string, ...parents: string[]) => ok(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", msg]);
      const a1 = commit("a1"); const a2 = commit("a2", a1);
      const r1 = commit("r1", a2);
      const a3 = commit("a3", a2);
      const m = commit("merge release/v9.1.0", a3, r1);
      const a4 = commit("a4", m);
      const b1 = commit("b1", a4);
      ok(["update-ref", "refs/remotes/origin/main", a4]);
      ok(["tag", "-a", "-m", "too early", "v9.1.0-early", r1]);
      ok(["tag", "-a", "-m", "release", "v9.1.0", m]);
      const tagObject = (name: string) => ok(["rev-parse", `refs/tags/${name}`]);

      // The step's own two commands, with $GITHUB_SHA filled in as the runner
      // would, and grep -xF's whole-line match on the list.
      const script = checkScript();
      const words = (cmd: string, sha: string) => cmd.split(" ").map((w) => w.replace(/^"|"$/g, "").replace("$GITHUB_SHA", sha));
      const peelCmd = PEEL.exec(script.find((l) => PEEL.test(l)) ?? "")?.[1];
      const askCmd = ASK.exec(script.find((l) => ASK.test(l)) ?? "")?.[1];
      expect(peelCmd && askCmd, "the check's commands are no longer in the form this runs").toBeTruthy();
      const released = (sha: string) => {
        const peeled = ok(words(peelCmd!, sha));
        return ok(words(askCmd!, sha)).split(/\r?\n/).includes(peeled);
      };

      // r1 IS in main's history — which is why ancestry is not the question.
      expect(git(["merge-base", "--is-ancestor", r1, "refs/remotes/origin/main"]).status).toBe(0);
      expect(released(r1), "a branch commit tagged before its merge is released once a merge commit brings it in").toBe(false);
      expect(released(tagObject("v9.1.0-early")), "the same commit, named by its annotated tag").toBe(false);
      expect(released(b1), "a commit on a branch never merged").toBe(false);
      expect(released(m), "the merge commit on main, which is what a release is tagged on").toBe(true);
      expect(released(tagObject("v9.1.0")), "the merge commit, named by its annotated tag").toBe(true);
      expect(released(a4), "main's tip, which a manual run from main releases").toBe(true);
      expect(released(a3), "an older commit of main's own, which a re-run releases").toBe(true);
    } finally {
      rmTempDir(dir);
    }
  });

  it("cannot be skipped or passed around", () => {
    const check = step("on-main", "Refuse a commit that is not on main");
    expect(check.body, "the check has an `if:` of its own, so it can be skipped while the job goes green")
      .not.toMatch(/\n {8}if: /);
    expect(job("on-main"), "on-main is continue-on-error, so its no changes nothing").not.toMatch(/continue-on-error/);
    expect(check.body, "the check swallows its own exit code").not.toMatch(/\|\|\s*true/);
  });
});

describe("what pull requests and pushes to main run", () => {
  it("is what it was: the gates and the desktop build, nothing that publishes", () => {
    for (const run of [{ event: "pull_request", ref: "refs/pull/1/merge" }, { event: "push", ref: "refs/heads/main" }]) {
      expect([...started(run)].sort(), `${run.event} ${run.ref}`).toEqual(["desktop", "floor", "test", "typecheck"]);
    }
  });
});
