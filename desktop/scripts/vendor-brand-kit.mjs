// Copies the brand kit files the desktop app uses into desktop/brand/kit,
// unchanged and at the same relative path, and rewrites the file table in
// desktop/brand/README.md. Run by hand, never by the build:
//
//   node desktop/scripts/vendor-brand-kit.mjs <kit>     the unpacked kit: the
//                                                       directory holding its
//                                                       VERSION and SHA256SUMS.txt
//   node desktop/scripts/vendor-brand-kit.mjs --table   only rewrite the table
//
// Which files: every kit file the plan in scripts/icons.mjs reads, and no
// other. Each is checked against the kit's own SHA256SUMS.txt before anything
// is copied, the kit's VERSION has to be KIT_VERSION in icons.mjs, and whatever
// the plan no longer reads is removed from desktop/brand/kit.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND, KIT_VERSION, iconPlan } from "./icons.mjs";

const TABLE_START = "<!-- files:start -->";
const TABLE_END = "<!-- files:end -->";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function filesUnder(dir, prefix = "") {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(dir, path) : [path];
  }).sort();
}

/** Every kit file the desktop app needs, as paths inside the kit. */
export function neededKitFiles() {
  return [...new Set(iconPlan().map(({ from }) => from.slice("kit/".length)))].sort();
}

/** The README's table: every file under desktop/brand and its SHA-256. */
export function fileTable(brand = BRAND) {
  const rows = filesUnder(brand)
    .filter(path => path !== "README.md")
    .map(path => `| \`${path}\` | \`${sha256(readFileSync(join(brand, path)))}\` |`);
  return ["| File | SHA-256 |", "|---|---|", ...rows].join("\n");
}

export function writeTable(brand = BRAND) {
  const readme = join(brand, "README.md");
  const text = readFileSync(readme, "utf8");
  const start = text.indexOf(TABLE_START), end = text.indexOf(TABLE_END);
  if (start === -1 || end < start) throw new Error(`${readme} has no ${TABLE_START} … ${TABLE_END} block to rewrite`);
  writeFileSync(readme, `${text.slice(0, start + TABLE_START.length)}\n${fileTable(brand)}\n${text.slice(end)}`);
}

export function vendorKit(kitDir, brand = BRAND) {
  const version = readFileSync(join(kitDir, "VERSION"), "utf8").trim();
  if (version !== KIT_VERSION) {
    throw new Error(`that kit is ${version} and icons.mjs takes ${KIT_VERSION}: change KIT_VERSION to take it`);
  }
  const sums = new Map(readFileSync(join(kitDir, "SHA256SUMS.txt"), "utf8").split("\n").filter(Boolean).map(line => {
    const [hash, path] = line.trim().split(/\s+\*?/);
    return [path, hash];
  }));
  const needed = neededKitFiles();
  for (const path of needed) {
    if (sums.get(path) !== sha256(readFileSync(join(kitDir, path)))) {
      throw new Error(`${path} is not the file the kit's SHA256SUMS.txt lists, so the kit is not as delivered`);
    }
  }
  rmSync(join(brand, "kit"), { recursive: true, force: true });
  for (const path of needed) {
    mkdirSync(dirname(join(brand, "kit", path)), { recursive: true });
    copyFileSync(join(kitDir, path), join(brand, "kit", path));
  }
  writeTable(brand);
  return needed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: node desktop/scripts/vendor-brand-kit.mjs <unpacked kit directory> | --table");
    process.exit(2);
  }
  if (arg === "--table") {
    writeTable();
    console.log("desktop/brand/README.md's file table rewritten");
  } else {
    const copied = vendorKit(arg);
    console.log(`${copied.length} kit files copied into ${join(BRAND, "kit")}, table rewritten`);
  }
}
