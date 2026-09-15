// #964: an 890 KB tarball of a retired package was the largest tracked file in
// the repo, and `*.tgz` was not ignored.
//
// WHAT WAS OBSERVED at 26e946b:
//
//   $ git ls-files -z | xargs -0 du -b | sort -rn | head -4
//   890474  agents-deck-3.19.0.tgz
//   821860  assets/canvas.png
//   521794  src/web/styles.css
//   345507  assets/social-preview.png
//
// Ahead of the hero screenshot. It was a build artifact of `agents-deck` — a
// package name README.md now says is no longer published — pinned at 3.19.0
// while the package shipped 3.22.15. Nothing referenced it: `agents-deck-3.19.0`
// and `.tgz` across src, bin, hook, .github, README.md, package.json and
// .gitattributes turned up only unrelated test fixtures and publish.yml's pack
// step, which packs to $RUNNER_TEMP. It was not in `package.json` `files`, so it
// had never shipped to npm; the whole cost was clone weight. It arrived in
// 4a25c6f, a change set about service installation — swept in from a local
// `npm pack`.
//
// Deleting it from HEAD is the whole fix. It stays in history, and history is
// not worth rewriting for 890 KB.
//
// WHY THERE IS A TEST AT ALL. The deletion needs no guard; the INVITATION does.
// `.gitignore` had no `*.tgz` rule, and packing is this repo's own way of
// checking a release, so a bare `npm pack` typed by hand drops a fresh tarball
// at the root as an untracked file in `git status`, one `git add .` away from
// repeating exactly this. The rule is the durable half of the fix and the rule
// is what can be silently dropped in a tidy-up.
//
// THE THIRD ASSERTION is a sentence in .gitattributes. That file explains its
// line-ending policy and ends on the one claim in it a reader can check — that
// `git ls-files --eol` reports `i/lf` for every tracked file except the two
// PNGs under assets/. It was wrong: there were three, because the tarball is
// binary too. That paragraph had already been rewritten once for going stale
// (item 5 of #779) and the new wording was chosen specifically to avoid a count
// that drifts; it went wrong anyway, not through drift but because a third
// binary appeared. Deleting the tarball made it true again without an edit,
// which is the neatest argument for deleting rather than describing — and this
// is what keeps it true.
//
// GIT IS ASKED DIRECTLY, and the file fails loudly rather than skipping if it
// cannot be. What is tracked is not derivable from the filesystem: an ignored
// file and an absent one look identical from `readdirSync`, and that difference
// is the entire subject here.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(repo, ...parts), "utf8");

/** `git <args>` in the repo root, as text. A failure here is a failure of the
 *  file: these questions have no other source. */
const git = (...args: string[]): string => {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    throw new Error(
      `\`git ${args.join(" ")}\` failed in ${repo}, so what this repo TRACKS cannot be read. `
        + "That question has no answer on the filesystem — an ignored file and a deleted one look the same — "
        + `so this file fails rather than passing on a guess. (${(err as Error).message})`,
    );
  }
};

/** Every tracked path. */
const tracked = () => git("ls-files").split("\n").filter(Boolean);

/**
 * The tracked paths git treats as binary, read off `ls-files --eol`.
 *
 * Each line is `i/<eol> w/<eol> attr/<attrs>\t<path>`, and the `i/` field is the
 * index's answer — `-text` for a file with no line endings to normalise. Parsed
 * by field rather than grepped for the string `-text`, which also matches five
 * tracked files whose NAMES contain it (copy-text.ts and four *-text-*.test.ts).
 */
const binaries = () =>
  git("ls-files", "--eol")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [info, path] = line.split("\t");
      return { binary: info.trim().split(/\s+/)[0] === "i/-text", path };
    })
    .filter((f) => f.binary)
    .map((f) => f.path)
    .sort();

describe("what a clone has to download", () => {
  it("tracks no package tarball", () => {
    // The deletion, held. A `.tgz` in the tree is always a build artifact of
    // something — there is no source file with that extension — and this repo
    // has a place for one already: publish.yml packs to $RUNNER_TEMP and
    // tarball-install-smoke.test.ts packs to a temp directory of its own.
    const tarballs = tracked().filter((p) => p.endsWith(".tgz"));
    expect(
      tarballs,
      `${tarballs.join(", ")} is tracked. A tarball in the tree is a build artifact somebody committed by `
        + "accident — agents-deck-3.19.0.tgz was 890 KB of one, the largest tracked file in the repo, for "
        + "several releases. Delete it from HEAD and let the ignore rule below keep the next one out.",
    ).toEqual([]);
  });

  it("ignores them, which is the half that stops the next one", () => {
    // The rule, not the file. `npm pack` typed by hand at the root leaves
    // `ccdeck-<version>.tgz` there; without this line it shows up in
    // `git status` as something to add.
    const ignored = read(".gitignore").split("\n").map((l) => l.trim());
    expect(
      ignored,
      "`.gitignore` no longer ignores *.tgz, so the next `npm pack` at the repo root leaves a tarball sitting "
        + "in `git status` waiting to be committed — which is exactly how the last one got in",
    ).toContain("*.tgz");
  });
});

describe("the one sentence in .gitattributes a reader can check", () => {
  it("still finds exactly the two PNGs it names, and nothing else", () => {
    // The paragraph says `git ls-files --eol` reports `i/lf` for every tracked
    // file except the two PNGs under assets/. It is the only checkable claim in
    // that file, and its job is to tell a contributor that a stray binary in
    // the tree is a mistake rather than a policy. A third entry makes the
    // paragraph a lie in the one place it was trying hardest not to be.
    expect(binaries(), "the set of tracked binaries has changed, and .gitattributes still says it is the two PNGs")
      .toEqual(["assets/canvas.png", "assets/social-preview.png"]);
    // Pinned together: the wording and the fact. Changing either alone is the
    // failure mode, and the paragraph was rewritten once already for exactly
    // that (item 5 of #779).
    expect(read(".gitattributes"), ".gitattributes no longer makes the claim this case checks")
      .toContain("tracked file except the two PNGs under assets/");
  });
});
