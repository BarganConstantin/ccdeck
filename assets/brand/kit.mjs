// Copies the brand kit into this repo and records what was copied.
//
//   node assets/brand/kit.mjs <kit-dir>   copy every file kit.json lists from
//                                         the kit, unchanged, to each place it
//                                         serves; then record the kit's version
//                                         and each file's SHA-256 in kit.json
//   node assets/brand/kit.mjs             re-record the hashes of the copies
//                                         already here, copying nothing
//
// <kit-dir> is the kit's root, the folder holding VERSION and SHA256SUMS.txt.
// A file the kit no longer has, or one that does not match the kit's own
// SHA256SUMS.txt, stops the copy before kit.json is written. kit.json is the
// one place the kit's version is written in this repo.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const RECORD = join(HERE, "kit.json");

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The kit's own SHA256SUMS.txt as path → hash, or null when it ships none. */
function kitSums(kit) {
  const file = join(kit, "SHA256SUMS.txt");
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  return new Map(lines.map((line) => {
    const [hash, ...name] = line.split(/\s+/);
    return [name.join(" ").replace(/^\*/, ""), hash];
  }));
}

function copyFrom(kit, record) {
  const sums = kitSums(kit);
  for (const { from, to } of record.files) {
    const source = join(kit, from);
    if (!existsSync(source)) throw new Error(`the kit at ${kit} has no ${from}; update its "from" in kit.json`);
    if (sums && sums.get(from) !== sha256(source)) throw new Error(`${from} does not match the kit's SHA256SUMS.txt`);
    for (const dest of to) {
      mkdirSync(dirname(join(REPO, dest)), { recursive: true });
      copyFileSync(source, join(REPO, dest));
    }
  }
  return readFileSync(join(kit, "VERSION"), "utf8").trim();
}

const record = JSON.parse(readFileSync(RECORD, "utf8"));
if (process.argv[2]) record.kit = copyFrom(resolve(process.argv[2]), record);
for (const file of record.files) {
  const hashes = new Set(file.to.map((dest) => sha256(join(REPO, dest))));
  if (hashes.size !== 1) throw new Error(`the copies of ${file.from} differ: ${file.to.join(", ")}`);
  file.sha256 = [...hashes][0];
}
const lines = record.files.map((f) => `    ${JSON.stringify(f)}`);
writeFileSync(RECORD, `{\n  "kit": ${JSON.stringify(record.kit)},\n  "files": [\n${lines.join(",\n")}\n  ]\n}\n`);
console.log(`brand kit ${record.kit}: ${record.files.length} files recorded in ${RECORD}`);
