// The register of every conditionally-skipped case in the suite, and what each
// one is expected to do on each of the three operating systems CI runs on.
//
// #525 added the three-OS matrix and one assertion to protect one gated case:
// cc-project-slug.test.ts's drive-colon rule, gated `skipIf(platform !==
// "win32")`, which "skipped" and "passed" both report as green, so a Windows
// leg could go green while the one case the Windows leg existed for carried on
// never running. That reasoning was right and it was aimed at one title.
//
// #585 is the audit of every other gate against the same reasoning, and it
// found two things the per-title assertion could not see.
//
//   The gated case the assertion protected did not need its gate. It has since
//   been un-gated — it compares tails, like its three siblings — so the title
//   the workflow looked up is not skipped anywhere any more, and an assertion
//   that only knows that one title now protects nothing.
//
//   Six gates skip on a *runtime probe* rather than on the platform:
//   `hardLinksWork` (four sites), `readOnlyDirBlocksWrites` and
//   `existsSync(dist/web/index.html)`. A platform gate cannot lie —
//   process.platform is what it is — but a probe answers a question about the
//   machine at import time, and if the answer changes the case disappears on
//   ALL THREE legs at once, with a green matrix either side of it. The
//   theme-first-paint one is the sharpest: its condition is satisfied by a
//   *step in the workflow* (`npm run build`), so deleting that step, renaming
//   vite's `build.outDir`, or moving index.html retires the only assertion in
//   the suite that reads the artifact that actually ships — silently.
//
// So the register below states, per gate site, when the case is expected to
// skip, as a pure function of `platform`. Every claim in it is therefore
// checkable from one machine, which matters because nobody here has all three.
// Two things read it:
//
//   skip-gate-inventory.test.ts re-derives the inventory from the test sources
//   and fails if the two disagree. That is what makes adding a gate without
//   registering it go red instead of passing quietly.
//
//   .github/workflows/publish.yml reads it after the suite and compares the
//   expectations here against what vitest's JSON report actually says was
//   skipped, on every leg rather than only on Windows. That is what catches a
//   probe that started answering the other way.
//
// It is .mjs, not .ts, and it is the one non-.ts module in this directory for
// that reason: the workflow step is plain `node` on a checkout with no
// transpiler in the path, and it has to import exactly the same file the test
// does. A second copy of these numbers in YAML is the drift this issue is
// about.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The platforms the matrix runs. Node's `process.platform` values, not GitHub's
 * runner labels, because that is what the gates themselves are written against.
 */
export const PLATFORMS = ["linux", "win32", "darwin"];

/**
 * Every condition a gate in this suite is written on, and when it holds.
 *
 * Keyed by the source text of the condition exactly as it appears between the
 * parentheses of `skipIf(` / `runIf(`, whitespace collapsed. A condition with
 * no entry here is an unregistered gate, and the inventory test says so.
 *
 * `holdsOn` answers whether the CONDITION is true, not whether the case skips —
 * `skipIf` skips when it holds and `runIf` skips when it does not, and the gate
 * kind supplies that half in `skipsOn` below.
 */
export const CONDITIONS = {
  'process.platform === "win32"': {
    holdsOn: (platform) => platform === "win32",
    why: "Signals, mode bits and /bin/sh are POSIX, and the fake-Windows cases build their fixture out of shell scripts and a ComSpec pointing at one, which cannot stand in for the real cmd.exe on a machine that has it.",
  },
  posix: {
    holdsOn: (platform) => platform !== "win32",
    why: "`const posix = process.platform !== \"win32\"` in no-shell-hook-commands.test.ts — the cases run a real /bin/sh.",
  },
  "!hardLinksWork": {
    // A runtime probe, and this is a claim about the runners rather than about
    // the code: every GitHub-hosted image answers true, ext4, APFS and NTFS all
    // implement link(2). A container bind-mount, a network share or an overlay
    // that does not would take all four atomic-rename guards with it at once —
    // the ones proving settings.json, the hook script, the sound park and the
    // uv binary are REPLACED rather than written into — so CI asserts the
    // answer rather than trusting it.
    holdsOn: () => false,
    why: "Hard links work on every filesystem the matrix runs on, so these four never skip in CI.",
  },
  "!readOnlyDirBlocksWrites": {
    // The only probe that legitimately answers differently per platform: chmod
    // on Windows toggles a read-only bit that does not stop a write into the
    // directory, so the probe reports false there and the case is skipped. It
    // also answers false for root, which is why moving CI to a container that
    // runs as root would retire the case on Linux too — and why that has to be
    // a deliberate edit here rather than a silent skip.
    holdsOn: (platform) => platform === "win32",
    why: "chmod 0555 does not block writes on Windows (nor for root), so the case cannot fail the write without also failing the read it needs first.",
  },
  "!existsSync(dist)": {
    // Satisfied by the `Build web bundle` step in publish.yml, not by anything
    // about the machine. The inventory test pins that step's existence for
    // exactly this reason.
    holdsOn: () => false,
    why: "publish.yml runs `npm run build` before the suite, so dist/web/index.html is always on disk in CI.",
  },
};

/**
 * The gate sites, grouped by (file, gate kind, condition) — deliberately with
 * no line numbers, which drift on every edit above them and would make this
 * register a maintenance tax rather than a check.
 *
 * `sites` is how many times that exact gate appears in that file; `cases` is
 * how many test cases sit behind them, which differs only for `describe.skipIf`
 * where one gate carries a whole block.
 */
// cc-project-slug.test.ts is deliberately absent: its drive-colon case used to
// be gated `skipIf(process.platform !== "win32")` and is not any more, which is
// why `expectedSkips("linux")` and `expectedSkips("darwin")` are now zero and
// why CI can assert the strongest possible thing on those two legs — that
// nothing was skipped at all.
export const GATES = [
  { file: "codex-auth-rename-retry.test.ts", gate: "it.skipIf", condition: 'process.platform === "win32"', sites: 1, cases: 1 },
  { file: "codex-auth-temp-collision.test.ts", gate: "describe.skipIf", condition: 'process.platform === "win32"', sites: 1, cases: 3 },
  { file: "exec-shim-callers.test.ts", gate: "it.skipIf", condition: 'process.platform === "win32"', sites: 5, cases: 5 },
  { file: "exec-timeout.test.ts", gate: "it.skipIf", condition: 'process.platform === "win32"', sites: 2, cases: 2 },
  { file: "exec-windows.test.ts", gate: "it.skipIf", condition: 'process.platform === "win32"', sites: 3, cases: 3 },
  { file: "settings-atomic-write.test.ts", gate: "it.skipIf", condition: 'process.platform === "win32"', sites: 1, cases: 1 },
  // #673's end-to-end block. Creating a FILE symlink on Windows needs
  // SeCreateSymbolicLinkPrivilege, so the seven cases that make one, run a
  // writer and look at what is left cannot be built there. The resolver block in
  // the same file is deliberately un-gated and runs on all three legs against a
  // directory junction — a reparse point Windows creates without a privilege —
  // and it carries the assertion that would catch a revert on that leg.
  { file: "settings-symlink-target.test.ts", gate: "describe.skipIf", condition: 'process.platform === "win32"', sites: 1, cases: 7 },
  { file: "supervisor-exit.test.ts", gate: "describe.skipIf", condition: 'process.platform === "win32"', sites: 1, cases: 3 },
  { file: "uv-bootstrap-atomic.test.ts", gate: "it.skipIf", condition: 'process.platform === "win32"', sites: 1, cases: 1 },

  { file: "no-shell-hook-commands.test.ts", gate: "it.runIf", condition: "posix", sites: 3, cases: 3 },

  { file: "hook-script-atomic.test.ts", gate: "it.skipIf", condition: "!hardLinksWork", sites: 1, cases: 1 },
  { file: "settings-atomic-write.test.ts", gate: "it.skipIf", condition: "!hardLinksWork", sites: 1, cases: 1 },
  { file: "sound-hook-park.test.ts", gate: "it.skipIf", condition: "!hardLinksWork", sites: 1, cases: 1 },
  { file: "uv-bootstrap-atomic.test.ts", gate: "it.skipIf", condition: "!hardLinksWork", sites: 1, cases: 1 },

  { file: "sound-hook-park.test.ts", gate: "it.skipIf", condition: "!readOnlyDirBlocksWrites", sites: 1, cases: 1 },

  { file: "theme-first-paint.test.ts", gate: "it.skipIf", condition: "!existsSync(dist)", sites: 1, cases: 1 },
];

/**
 * Does a gate's cases skip on `platform`?
 *
 * `skipIf(c)` skips when c holds; `runIf(c)` skips when it does not. Written as
 * a function of the platform rather than read off the running one so that all
 * three answers are checkable from any one machine.
 */
export function skipsOn(entry, platform) {
  const condition = CONDITIONS[entry.condition];
  if (!condition) throw new Error(`unregistered gate condition: ${entry.condition}`);
  const holds = condition.holdsOn(platform);
  return entry.gate.endsWith("runIf") ? !holds : holds;
}

/**
 * What the suite is expected to report as skipped on `platform`: a total, and
 * the per-file breakdown CI compares the JSON report against file by file, so a
 * mismatch names the gate that moved instead of only the arithmetic.
 */
export function expectedSkips(platform) {
  if (!PLATFORMS.includes(platform)) throw new Error(`unknown platform: ${platform}`);
  const byFile = {};
  let total = 0;
  for (const entry of GATES) {
    if (!skipsOn(entry, platform)) continue;
    byFile[entry.file] = (byFile[entry.file] ?? 0) + entry.cases;
    total += entry.cases;
  }
  return { total, byFile };
}

// ── What CI checks the report against ───────────────────────────────────────

/**
 * Compare vitest's JSON report against what this register says should have been
 * skipped on `platform`.
 *
 * This is the generalisation of #525's per-title step. That one looked up a
 * single title and asked whether it passed, which covered exactly one gate and
 * only on one leg. This asks the whole question — "did the suite run every case
 * it was supposed to?" — file by file, on every leg, so it is equally red when
 * a probe stops answering the way the register says it does and when a case is
 * skipped that nothing here accounts for.
 *
 * It lives here rather than inline in the workflow so that it is testable: the
 * mutation that proves a guard has teeth is much easier to write against a
 * function than against a YAML step nobody can run locally.
 *
 * Anything vitest did not report as `passed` or `failed` counts as not having
 * run — `pending` for a skip, `todo` for a placeholder. A failure is loud on
 * its own; this step is only about silence.
 */
export function auditReport(report, platform) {
  const expected = expectedSkips(platform);
  const problems = [];
  const lines = [];

  const files = report?.testResults;
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, lines, problems: ["the vitest report lists no test files at all"] };
  }

  const actual = {};
  for (const file of files) {
    const name = String(file.name).split(/[\\/]/).pop();
    for (const test of file.assertionResults ?? []) {
      if (test.status === "passed" || test.status === "failed") continue;
      actual[name] = (actual[name] ?? 0) + 1;
    }
  }

  lines.push(`platform ${platform}: the register expects ${expected.total} skipped case(s)`);
  for (const [file, n] of Object.entries(expected.byFile).sort()) {
    lines.push(`  expected ${n} in ${file}, report says ${actual[file] ?? 0}`);
  }

  for (const [file, n] of Object.entries(expected.byFile)) {
    const saw = actual[file] ?? 0;
    if (saw === n) continue;
    problems.push(
      `${file}: the register expects ${n} skipped case(s) on ${platform} and vitest reported ${saw}. ` +
      (saw < n
        ? "A gate that was supposed to skip here ran instead — register the change, or find out why the condition moved."
        : "Something skipped that is not registered — most likely a runtime probe answered the other way and took its case with it."),
    );
  }
  for (const [file, n] of Object.entries(actual)) {
    if (file in expected.byFile) continue;
    problems.push(
      `${file}: vitest skipped ${n} case(s) here and the register lists no gate that skips on ${platform}. ` +
      "Either a new gate was added without registering it in src/web/__tests__/skip-gates.mjs, or a probe stopped answering the way the register says it does.",
    );
  }

  const total = Object.values(actual).reduce((n, m) => n + m, 0);
  lines.push(`report total: ${total} skipped case(s) across ${files.length} file(s)`);
  return { ok: problems.length === 0, lines, problems };
}

// ── Deriving the same inventory from the sources ────────────────────────────
// Read rather than parsed: a real parser is a dependency this repo does not
// have, and the shape being looked for is narrow enough that a scanner is
// honest about its own limits. Where it cannot see something it under-counts,
// and an under-count fails against the register rather than passing.

const GATE_RE = /\b(it|test|describe)\.(skipIf|runIf)\(/g;

/** The source text between one balanced pair of parens starting at `open`. */
const balanced = (src, open) => {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error("unbalanced parentheses after a gate");
};

/**
 * How many cases a `describe.skipIf` block carries.
 *
 * Both such blocks in this suite start at column 0 and run to the next
 * column-0 statement or to the end of the file, so the block is that slice and
 * the cases are the `it(` calls in it. A case nested one describe deeper would
 * be counted the same way; a THIRD level of nesting is not something this
 * suite does, and if it ever appears the count here moves and the inventory
 * test says so rather than staying quiet.
 */
const casesInBlock = (src, from) => {
  const rest = src.slice(from);
  const end = rest.slice(1).search(/\n(?:describe|it|test)[.(]/);
  const block = end === -1 ? rest : rest.slice(0, end + 1);
  // Anchored to the start of a line so the word "it" in a comment sentence
  // cannot be counted as a case.
  return [...block.matchAll(/^[ \t]*(?:it|test)(?:\.\w+)*\s*\(/gm)].length;
};

/**
 * Scan one test source and return its gate sites, one entry per occurrence.
 *
 * A `//` earlier on the same line means the match is prose — several files in
 * this suite explain in a comment why they are NOT gated, and those sentences
 * must not register as gates.
 */
export function scanSource(file, src) {
  const found = [];
  for (const m of src.matchAll(GATE_RE)) {
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    if (src.slice(lineStart, m.index).includes("//")) continue;
    const gate = `${m[1]}.${m[2]}`;
    const open = m.index + m[0].length - 1;
    const condition = balanced(src, open).trim().replace(/\s+/g, " ");
    const cases = m[1] === "describe" ? casesInBlock(src, m.index) : 1;
    found.push({ file, gate, condition, cases });
  }
  return found;
}

/**
 * The register's own shape — grouped by (file, gate, condition) with a site
 * count — derived from a list of per-occurrence sites, so the two are directly
 * comparable.
 */
export function group(sites) {
  const byKey = new Map();
  for (const site of sites) {
    // JSON rather than a separator: a condition can contain anything, and a
    // delimiter that shows up inside one would merge two distinct gates.
    const key = JSON.stringify([site.file, site.gate, site.condition]);
    const seen = byKey.get(key);
    if (seen) { seen.sites++; seen.cases += site.cases; }
    else byKey.set(key, { file: site.file, gate: site.gate, condition: site.condition, sites: 1, cases: site.cases });
  }
  return [...byKey.values()].sort((a, b) =>
    `${a.file}${a.condition}`.localeCompare(`${b.file}${b.condition}`));
}

/**
 * The whole suite's gate inventory, read off disk.
 *
 * The file list comes from the directory rather than from a constant, so a
 * brand-new test file with a brand-new gate in it is scanned the moment it
 * lands — which is the case the register would otherwise be blind to.
 */
export function scanTestSources(files = readdirSync(HERE).filter((f) => f.endsWith(".test.ts")).sort()) {
  return group(files.flatMap((file) => scanSource(file, readFileSync(join(HERE, file), "utf8"))));
}

/** The register in the scan's order, so the two lists compare element by element. */
export function registeredGates() {
  return [...GATES].sort((a, b) => `${a.file}${a.condition}`.localeCompare(`${b.file}${b.condition}`));
}
