// Which build of the package this is, when it is not a release.
//
// A pull request's CI package and its desktop installers carry the version of
// the release their branch started from — package.json is not touched, so the
// deck's update check reads a test build exactly as it reads that release and
// never takes it for a newer one. That left nothing to tell the two apart:
// `ccdeck --version` said 3.38.1 for both. So for a pull request, and only
// then, the CI writes the branch and the commit into build-info.json beside
// this file (`node src/server/build-info.mjs --write`, from the event's own
// values in the environment), and `ccdeck --version`, /api/version and the
// version chip say them: "3.38.1 (feature/git-view @ abc1234)". A release is
// built from a checkout that has no such file (it is ignored by git), so it
// says its version and nothing more.
//
// A leaf — fs, path and url — so bin/deck.js can read it on its way to
// printing the version without starting anything.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Where the file sits, from the package's root. */
export const BUILD_INFO_PATH = join("src", "server", "build-info.json");

const SHA = /^[0-9a-f]{7,40}$/;
const BRANCH_MAX = 200;
// A branch name is anyone's to choose: nothing that could break a line or a
// terminal is shown.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** The branch and commit a file says, or null for anything else. */
function parse(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const branch = typeof raw.branch === "string" ? raw.branch.trim() : "";
  const sha = typeof raw.sha === "string" ? raw.sha.trim().toLowerCase() : "";
  if (!branch || branch.length > BRANCH_MAX || CONTROL.test(branch) || !SHA.test(sha)) return null;
  return { branch, sha };
}

/** The build a package root says it is, or null for a release (no file) and
 *  for a file that says nothing it can be trusted for. */
export function readBuildInfo(pkgRoot) {
  try { return parse(JSON.parse(readFileSync(join(pkgRoot, BUILD_INFO_PATH), "utf8"))); }
  catch { return null; }
}

/** Write the file into a package root: the CI's half. */
export function writeBuildInfo(pkgRoot, info) {
  const ok = parse(info);
  if (!ok) throw new Error("build info needs a branch and a commit SHA");
  writeFileSync(join(pkgRoot, BUILD_INFO_PATH), `${JSON.stringify(ok)}\n`);
  return ok;
}

/** A version as a build says it: the version alone for a release, with the
 *  branch and the short commit for a test build. */
export function versionWithBuild(version, info) {
  return info ? `${version} (${info.branch} @ ${info.sha.slice(0, 7)})` : version;
}

// `node src/server/build-info.mjs --write`: the CI, for a pull request.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv.includes("--write")) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const info = writeBuildInfo(root, { branch: process.env.BUILD_BRANCH, sha: process.env.BUILD_SHA });
  console.log(`build ${versionWithBuild(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, info)}`);
}
