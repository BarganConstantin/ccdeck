// Check a release's signed updates the way an installed app will, before
// anything is uploaded.
//
//   node scripts/verify-updates.mjs <dir> <version>
//
// Reads every manifest in <dir> — latest-mac.json, latest.yml,
// latest-linux.yml — and checks each file it lists with the public key compiled
// into the app (updater-mac.mjs): the manifest is <version>, and every file
// carries both the signature over its bytes that apps already in the field
// check and the release signature over its bytes, name and version that apps
// from now on require. A release that fails here would be refused by every
// installed app, or by every new one, so the build stops instead: nobody is
// left on a version that can no longer update itself.
//
// It also catches CI's key and the app's key drifting apart, which nothing else
// would notice until the first update was refused on people's machines.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { UPDATE_PUBLIC_KEY, verifyRelease, verifyZip } from "../updater-mac.mjs";
import { verifyDownload } from "../updater.mjs";

/** Every problem with the manifests in `dir`, as lines; none means the
 *  release installs. `readYml` parses a yml (js-yaml's load in CI). */
export function updateProblems(dir, version, { readYml, publicKeyPem = UPDATE_PUBLIC_KEY }) {
  const problems = [];
  const manifests = [];
  const read = name => readFileSync(join(dir, basename(name)));

  if (existsSync(join(dir, "latest-mac.json"))) {
    const manifest = JSON.parse(readFileSync(join(dir, "latest-mac.json"), "utf8"));
    manifests.push("latest-mac.json");
    if (manifest.version !== version) problems.push(`latest-mac.json is ${manifest.version}, not ${version}`);
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    if (files.length === 0) problems.push("latest-mac.json lists no files");
    for (const file of files) {
      const bytes = read(file.url);
      if (!verifyZip(bytes, file, publicKeyPem)) problems.push(`${file.url}: its hash or byte signature does not verify`);
      if (!verifyRelease(bytes, { version: manifest.version, name: basename(file.url), signature: file.ed25519Release }, publicKeyPem)) {
        problems.push(`${file.url}: its release signature does not verify as ${manifest.version}`);
      }
    }
  }

  for (const name of readdirSync(dir).filter(n => /^latest.*\.yml$/.test(n) && n !== "latest-mac.yml")) {
    const doc = readYml(readFileSync(join(dir, name), "utf8"));
    manifests.push(name);
    if (doc?.version !== version) problems.push(`${name} is ${doc?.version}, not ${version}`);
    const urls = [...new Set([...(doc?.files ?? []).map(f => f?.url), doc?.path].filter(u => typeof u === "string"))];
    if (urls.length === 0) problems.push(`${name} lists no files`);
    for (const url of urls) {
      if (!verifyDownload(read(url), doc, join(dir, basename(url)), publicKeyPem)) {
        problems.push(`${name}: ${url} is not signed by ccdeck's update key as ${doc?.version}`);
      }
    }
  }

  if (manifests.length === 0) problems.push(`no update manifest in ${dir}`);
  return problems;
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const [dir, version] = process.argv.slice(2);
  if (!dir || !version) { console.error("usage: verify-updates.mjs <dir> <version>"); process.exit(2); }
  // Here and not at the top, for the reason sign-yml.mjs gives.
  const { default: yaml } = await import("js-yaml");
  const problems = updateProblems(dir, version, { readYml: text => yaml.load(text) });
  if (problems.length) {
    for (const p of problems) console.error(`::error::${p}`);
    process.exit(1);
  }
  console.log(`every update in ${dir} verifies as ${version} with the key the app carries`);
}
