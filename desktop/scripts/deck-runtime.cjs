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

// The Command Panel's engine. Each platform's engine is its own npm package,
// @ccdeck/engine-<platform>-<arch>, listed as an optional dependency of the
// deck so npm installs the one that fits the machine; the deck finds it by
// walking up from its own folder through each node_modules, so in the app it
// has to sit in Resources/deck/node_modules like everything above. The walk
// above follows `dependencies` only and never reaches it, and the build
// machine holds only its own CPU's package anyway — so each platform section
// of the config copies the package for the arch being packed, and beforePack
// refuses a target whose package is not there.
//
// The root package.json is the one list. Until its optionalDependencies name an
// engine package, nothing here adds a file to the app or checks for one.
const ENGINE_PREFIX = "@ccdeck/engine-";
const ENGINE_NAME = /^@ccdeck\/engine-(darwin|linux|win32)-(x64|arm64)$/;
// The deck verifies the engine against a manifest signed for one version, so
// the package it ships is one exact version, never whatever a range resolves to.
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The engine packages the root package.json lists, as
 *  { name, platform, arch, spec } — none while it lists none. */
function enginePackages(root = ROOT) {
  const listed = manifest(resolve(root)).optionalDependencies || {};
  return Object.keys(listed).filter(name => name.startsWith(ENGINE_PREFIX)).map(name => {
    const match = ENGINE_NAME.exec(name);
    if (!match) throw new Error(`${name} in the root package.json is not a package the desktop app can place: expected @ccdeck/engine-<darwin|linux|win32>-<x64|arm64>`);
    return { name, platform: match[1], arch: match[2], spec: listed[name] };
  });
}

/** The exact version the root package.json pins an engine package to. */
function exactPin({ name, spec }, target) {
  if (typeof spec === "string" && EXACT_VERSION.test(spec)) return spec;
  throw new Error(`The root package.json must pin ${name} to an exact version, not ${JSON.stringify(spec)}${target ? ` (packing ${target})` : ""}`);
}

/** A platform section's own extraResources, which electron-builder adds to the
 *  top-level ones: the engine package for the arch being packed, `${arch}`
 *  being its macro for that arch (x64 or arm64, the words Node and the package
 *  names use). The whole published package — executable, manifest.json,
 *  package.json and its notices. Nothing while the root package.json lists no
 *  engine package for `platform` (Node's name: darwin, win32, linux). */
function engineResources(platform, root = ROOT) {
  if (!enginePackages(root).some(engine => engine.platform === platform)) return {};
  const name = `${ENGINE_PREFIX}${platform}-\${arch}`;
  return { extraResources: [{ from: `../node_modules/${name}`, to: `deck/node_modules/${name}` }] };
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
  // electron-builder skips an extraResources folder that is not there, without
  // a word: a listed engine missing here would ship an app with no engine.
  const engines = enginePackages(root);
  for (const cpu of arches) {
    const target = `${context.electronPlatformName}-${cpu}`;
    const engine = engines.find(listed => `${listed.platform}-${listed.arch}` === target);
    if (engine) validateEngine(engine, root, target);
  }
}

function validateEngine(engine, root, target) {
  const version = exactPin(engine, target);
  const dir = join(resolve(root), "node_modules", ...engine.name.split("/"));
  let pkg;
  try {
    pkg = manifest(dir);
  } catch {
    throw new Error(`Missing engine package ${engine.name} for ${target}: no ${join(dir, "package.json")}; run npm ci at the repository root, and for the other Mac arch node desktop/scripts/engine-packages.cjs darwin x64 arm64`);
  }
  if (pkg.name !== engine.name) throw new Error(`The engine package folder for ${target} holds ${pkg.name}, not ${engine.name}: ${dir}`);
  if (pkg.version !== version) throw new Error(`Engine package ${engine.name} for ${target} is ${pkg.version}, and the root package.json pins ${version}`);
  if (!existsSync(join(dir, "manifest.json"))) throw new Error(`Engine package ${engine.name} for ${target} has no manifest.json: ${dir}`);
}

module.exports = { engineResources, enginePackages, exactPin, runtimeResources, validateRuntime };
