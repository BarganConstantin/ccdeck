// The hosted server runs outside app.asar. Its dependencies must live beside
// it, not beside Electron's main process inside the archive. Keep npm's nested
// layout and whole published packages, including native prebuilds and licences.
const { existsSync, readFileSync } = require("node:fs");
const { dirname, join, relative, resolve, sep } = require("node:path");

const ROOT = resolve(__dirname, "../..");
const manifest = dir => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

function resolvePackage(name, parent, root) {
  for (let dir = parent; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === root || dirname(dir) === dir) break;
  }
  throw new Error(`Missing deck runtime dependency ${name}; run npm ci at the repository root`);
}

function runtimeResources(root = ROOT) {
  root = resolve(root);
  const found = new Map();
  function visit(name, parent) {
    const dir = resolvePackage(name, parent, root);
    if (found.has(dir)) return;
    const pkg = manifest(dir);
    const destination = relative(join(root, "node_modules"), dir).split(sep).join("/");
    found.set(dir, {
      from: dir,
      to: `deck/node_modules/${destination}`,
      filter: ["**/*", "!node_modules/**/*"],
    });
    for (const dependency of Object.keys(pkg.dependencies || {})) visit(dependency, dir);
  }
  for (const name of Object.keys(manifest(root).dependencies || {})) visit(name, root);
  return [...found.values()];
}

function validateRuntime(context, root = ROOT) {
  const resources = runtimeResources(root);
  const native = resources.find(entry => manifest(entry.from).name === "fs-native-extensions");
  if (!native) throw new Error("Missing fs-native-extensions in deck runtime dependencies");
  // electron-builder's Arch enum; accept strings too for local validation.
  const arch = typeof context.arch === "string" ? context.arch : ["ia32", "x64", "armv7l", "arm64", "universal"][context.arch];
  const arches = arch === "universal" ? ["x64", "arm64"] : [arch];
  for (const cpu of arches) {
    const target = `${context.electronPlatformName}-${cpu}`;
    const binary = join(native.from, "prebuilds", target, "fs-native-extensions.node");
    if (!existsSync(binary)) throw new Error(`Missing deck native prebuild for ${target}: ${binary}`);
  }
}

module.exports = { runtimeResources, validateRuntime };
