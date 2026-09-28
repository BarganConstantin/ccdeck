// Which install this running copy is, and what would update it.
//
// These lived in src/server/self-update.mjs, between the version comparison and
// the registry check: the three sections that ask a package directory who it is
// — its own manifest, the npx cache it may sit in, the package it may be nested
// inside — and the three answers built on them: the package an upgrade installs,
// the one npm is asked about, and the line the user can paste. None of it talks
// to the network or keeps any state, so it moved to a leaf of its own.
// self-update.mjs imports what it calls and re-exports every name, so
// bin/agent-dag.js, invoked-as.mjs and the login item still import them from
// there. The code is unchanged.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── what is on disk ──────────────────────────────────────────────────────────

/** A package directory's own manifest, or null when there is not one worth
 *  reading there.
 *
 *  Shared by everything below that asks a directory who it is — the npx cache
 *  directory's record of the spec included — so its callers cannot drift on
 *  what a missing, truncated or non-object package.json means. A JSON document
 *  is not necessarily an object — `null`, `"ccdeck"` and `[]` all parse — and a
 *  manifest that is not an object has no fields to read, so it is refused here
 *  once rather than guarded against at every caller. */
function readManifest(dir) {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return meta && typeof meta === "object" ? meta : null;
  } catch {
    return null;
  }
}

/** Version currently written in the package's own package.json. Deliberately
 *  read fresh on every call: that is the whole point — it changes under a
 *  running process when npm replaces the install.
 *
 *  And sometimes the directory changes with it. A `npm i -g ccdeck` performed
 *  before #340 left the deck nested inside a launcher package; upgrading such an
 *  install now writes the flat tarball over that launcher, and npm's reify takes
 *  the nested copy — the one this process is running out of — with it. Reading
 *  our own manifest then answers null, which pickNotice reads as "nothing is
 *  installed" and turns into the same upgrade offered forever, with the restart
 *  notice this module exists for never firing at all.
 *
 *  The version is not lost, it moved one directory up. successorRoot is where
 *  to, and it answers null in every layout where nothing moved — so the normal
 *  case still reads exactly one manifest. */
export function installedVersion(pkgRoot) {
  const own = readManifest(pkgRoot);
  if (typeof own?.version === "string") return own.version;
  const moved = successorRoot(pkgRoot);
  const v = moved ? readManifest(moved)?.version : null;
  return typeof v === "string" ? v : null;
}

/** npx keeps each package in its own content-addressed cache directory, so
 *  `npm i -g` is the wrong advice there — nothing global exists to upgrade. */
export function isNpxInstall(pkgRoot) {
  // Split on both separators, not `path.sep`: Windows paths reach here with
  // backslashes but a POSIX-style path is still a valid input there, and a
  // separator-agnostic test is what keeps this identical on all three
  // platforms. Segment-wise, so a directory merely named "my_npx-tools" is not
  // mistaken for the npx cache.
  return typeof pkgRoot === "string" && pkgRoot.split(/[\\/]/).includes("_npx");
}

/** A git checkout is the maintainer's own tree. Its version routinely sits
 *  ahead of npm, and telling someone to `npm i -g` over their working copy is
 *  actively wrong, so the registry side of the check is skipped there.
 *
 *  Exported for one caller outside the self-update modules: the login item,
 *  which must not be installed from a checkout for the same reason it must not
 *  be installed from an npx run — the path is not one anybody promised to keep.
 *  Everything else it gates stays internal to them, and each of those is already
 *  asserted against a directory with a real `.git` in it — `upgradeCommand`
 *  returning "git pull && npm run build", `upgradeName` refusing to move a
 *  checkout onto a published alias, and `startUpgrade` refusing with
 *  `git_checkout`. A test importing the predicate would restate what those three
 *  already prove, one level further from the behaviour a user can see.
 *
 *  `existsSync` and not a directory test, deliberately (#587). Git writes `.git`
 *  as a directory only for an ordinary clone; a linked worktree and a submodule
 *  each get a FILE whose whole content is one `gitdir:` line, and all three are
 *  checkouts nobody may install over. Nothing here reads that line, which is
 *  also what keeps the rule identical on Windows, where the path inside it
 *  carries a drive letter and backslashes. Both shapes are covered in
 *  worktree-git-file-587.test.ts and beside every checkout fixture in the
 *  suite — narrowing this to `.isDirectory()` fails them. */
export function isGitCheckout(pkgRoot) {
  try { return existsSync(join(pkgRoot, ".git")); } catch { return false; }
}

// ── npx ──────────────────────────────────────────────────────────────────────
//
// An npx run lives in ~/.npm/_npx/<hash>/node_modules/<pkg>. The hash is over
// the SPEC the user typed, so upgrading means fetching a different directory —
// there is nothing to install over. What there IS, is the spec itself: npm
// writes it into <hash>/package.json as `_npx.packages`, which is the only
// record of whether the user typed `ccdeck`, `agent-dag` or `agents-deck`.
// Re-running the wrong one would work but would leave them on a package they
// never asked for, so it is worth reading rather than guessing.

/** The separator to join a path's segments back with: the one the input used,
 *  because a Windows path must come back as one. Backslashes only when the
 *  path has no forward slash at all — POSIX-style input is valid on Windows
 *  too. Shared by npxRoot and hostRoot, the two that cut a path apart and
 *  hand a piece of it back. */
function sepOf(path) {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** The `_npx/<hash>` directory this package was unpacked into, or null. Pure —
 *  path arithmetic only, so both platforms' separators can be tested. */
export function npxRoot(pkgRoot) {
  if (typeof pkgRoot !== "string") return null;
  const parts = pkgRoot.split(/[\\/]/);
  const i = parts.lastIndexOf("_npx");
  if (i === -1 || i + 1 >= parts.length) return null;
  return parts.slice(0, i + 2).join(sepOf(pkgRoot));
}

/** Package name out of an npm spec, scope intact: `ccdeck@1.2.3` → `ccdeck`,
 *  `@scope/pkg` → `@scope/pkg`. Null for anything that is not a plain name —
 *  a tarball URL or a git spec is not something to re-run with `@latest`. */
export function bareSpecName(spec) {
  if (typeof spec !== "string") return null;
  const s = spec.trim();
  if (!s) return null;
  const at = s.lastIndexOf("@");
  const name = at > 0 ? s.slice(0, at) : s;
  return /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/i.test(name) ? name : null;
}

/** What to hand `npx -y`, read from the cache directory's own metadata.
 *
 *  `fallback` is what to answer when that metadata names nothing usable — the
 *  package name, for the caller whose job is to re-run SOMETHING. Pass null and
 *  the answer is null instead, which is what invoked-as.mjs needs: it asks which
 *  name the user typed, and there the package name is not a lesser answer, it is
 *  a wrong one. */
export function npxSpecFromMeta(meta, fallback = PUBLISHED_NAME) {
  const list = meta && meta._npx && Array.isArray(meta._npx.packages) ? meta._npx.packages : [];
  for (const entry of list) {
    const name = bareSpecName(entry);
    if (name) return `${name}@latest`;
  }
  return fallback ? `${fallback}@latest` : null;
}

/** The same, answered against the filesystem. Null when this is not an npx run,
 *  and — for a caller that passed no fallback — when the metadata cannot be
 *  read. */
export function npxRestartSpec(pkgRoot, name = PUBLISHED_NAME) {
  const root = npxRoot(pkgRoot);
  if (!root) return null;
  return npxSpecFromMeta(readManifest(root), name);
}

// ── the package that installed us ────────────────────────────────────────────
//
// Two of the three names on npm are this tarball republished; the third is not
// this tarball at all. `ccdeck` is a stub that ships nothing but bin/ and
// depends on `agents-deck`, so `npm i -g ccdeck` produces a layout no other
// install does: npm stopped hoisting a global package's dependencies in v7, so
// the deck lands at `<prefix>/lib/node_modules/ccdeck/node_modules/agents-deck`
// and the process runs out of a directory owned by a package it is not named
// after.
//
// #351 taught the stub to FIND the deck there. Nothing downstream learned about
// it, so every self-update surface went on naming `agents-deck` — which in that
// layout resolves to `<prefix>/lib/node_modules/agents-deck`, a directory this
// process never reads and a `npm i -g ccdeck` user usually does not have at
// all. "Update now" therefore installed a second, unrelated tree: the running
// install never moved, so installedVersion stayed put, the restart notice never
// came, and the banner offered the identical update forever while the upgrade
// reported "done".
//
// So the name to install is not the name this build was PUBLISHED under, it is
// the name the install was REACHED under — and under the stub layout that is
// written on disk one directory up. Read from there rather than from argv[1]
// (invoked-as.mjs answers the neighbouring question of which command the user
// TYPED, and cannot answer this one): the stub spawns the deck by absolute
// path, so argv[1] reads `agent-dag.js` under all three names, and on Windows
// npm's .cmd/.ps1 shims never pass the typed name on at all. The directory npm
// built is the one carrier that survives every platform.
//
// The other two names need no layout at all, and that is why the first fix
// missed one of them. `agents-deck` and `agent-dag` are the same tarball
// published twice with the manifest renamed between the two, so the deck IS the
// whole package under both and sits directly under the global node_modules with
// nothing above it — hostPackage correctly finds no host, and the answer falls
// through to a default that is right for one of the two and wrong for the
// other. What both of them do carry is their own package.json, which npm's
// rename made authoritative: see installedName.

/** Every name an install of this deck can have been REACHED under.
 *
 *  Only `ccdeck` is published now. `agents-deck` and `agent-dag` were this
 *  tarball published twice more, then (from 3.22.3) small packages that
 *  depended on ccdeck, and both stay on the registry at their last version — so
 *  a deck can still be running inside one of them, or out of an npx run of one
 *  of them, and this list is what lets it recognise that. It is not the list of
 *  names to ask npm about: see PUBLISHED_NAME. The same three strings as
 *  invoked-as.mjs's COMMANDS, and deliberately not that list: this is the set
 *  of npm PACKAGES an install may belong to, that is the set of commands a user
 *  may have typed. A test pins them against each other rather than either side
 *  assuming it. */
export const ALIAS_PACKAGES = ["agents-deck", "agent-dag", "ccdeck"];

/** The one name the deck is published under, and so the only package whose
 *  dist-tag still moves. */
export const PUBLISHED_NAME = "ccdeck";

/** The names it is no longer published under. */
export const RETIRED_NAMES = ["agents-deck", "agent-dag"];

/** The published name in place of a retired one; any other name unchanged. */
export function currentName(name) {
  return RETIRED_NAMES.includes(name) ? PUBLISHED_NAME : name;
}

/** Which of those three THIS build was published as, out of its own manifest.
 *
 *  The other half of the same bug, and the easier half. `agent-dag` is not a
 *  stub and is not nested inside anything — `npm i -g agent-dag` puts the deck
 *  straight into `<prefix>/lib/node_modules/agent-dag` — so hostPackage finds no
 *  host above it and there is no layout to read the answer out of. There does
 *  not need to be: CI publishes that name by renaming the manifest in the
 *  tarball (`npm pkg set name=agent-dag` in .github/workflows/publish.yml), so
 *  the running copy's own package.json says `agent-dag` and has all along.
 *
 *  It was never read. `name` is a parameter with a default in every exported
 *  function here, and not one caller in the deck passes it — index.mjs and
 *  bin/deck.js both call versionReport and startUpgrade with a pkgRoot and
 *  nothing else — so the default WAS the answer, and the default is a guess
 *  about which of three names this build carries. For `npm i -g agent-dag` it
 *  guessed wrong: the user was told to run `npm i -g agents-deck@latest`, which
 *  installs a second, unrelated global package while their `agent-dag` binary
 *  stays exactly where it was, and the version check went on caching under a
 *  package this install is not.
 *
 *  Confined to the three names, for the reason hostNameFromMeta is: the answer
 *  becomes an argument in the `npm i -g` this process spawns, and startUpgrade
 *  promises that vector can only ever name this deck. A fork that republishes
 *  under a fourth name adds it to the list above, which is one line and a
 *  deliberate one — rather than having the deck hand npm a package name it has
 *  never heard of because a directory on disk said so.
 *
 *  `fallback` is what to answer when the manifest is missing, unreadable, or
 *  names something that is not one of ours — the caller's own `name`, so every
 *  shape that cannot prove which alias it is keeps the behaviour it had. */
export function installedName(pkgRoot, fallback = PUBLISHED_NAME) {
  const self = readManifest(pkgRoot)?.name;
  return typeof self === "string" && ALIAS_PACKAGES.includes(self) ? self : fallback;
}

/** The directory of the package this one is installed INSIDE, or null when it
 *  is not inside one. Pure — path arithmetic only, so a Windows layout can be
 *  tested on a POSIX box and both separators are split on, exactly as npxRoot
 *  does it and for the same reason. */
export function hostRoot(pkgRoot) {
  if (typeof pkgRoot !== "string") return null;
  const parts = pkgRoot.split(/[\\/]/);
  // `<host>/node_modules/<us>` and nothing else: the segment directly above us
  // has to be the node_modules npm nested us into, and the one above that is
  // the host. A scoped package would sit one level deeper, under `@scope`, and
  // is refused here rather than guessed at — none of the three names is scoped.
  if (parts.length < 3 || parts[parts.length - 2] !== "node_modules") return null;
  return parts.slice(0, -2).join(sepOf(pkgRoot)) || null;
}

/** The host package's name, out of its own manifest — but only when it is one
 *  of this deck's aliases AND it declares a dependency on us.
 *
 *  The alias half is the load-bearing one. Any project that lists `agents-deck`
 *  in its dependencies and runs it out of its own node_modules — a workspace, a
 *  CI job, a tool that embeds the deck — is in exactly the same shape on disk
 *  as the stub, and answering with THAT name would have the deck offering to
 *  `npm i -g their-app@latest`: a package it has no business installing, and on
 *  a private name one that does not exist. Confining the answer to the three
 *  published names leaves every such install with the fallback it has today. */
export function hostNameFromMeta(meta, name = PUBLISHED_NAME) {
  const host = typeof meta?.name === "string" ? meta.name : null;
  if (!host || !ALIAS_PACKAGES.includes(host)) return null;
  return typeof meta?.dependencies?.[name] === "string" ? host : null;
}

/** The same, answered against the filesystem: `{ root, name }` for the alias
 *  package this copy was installed as a dependency of, or null. */
export function hostPackage(pkgRoot, name = PUBLISHED_NAME) {
  const root = hostRoot(pkgRoot);
  if (!root) return null;
  const host = hostNameFromMeta(readManifest(root), name);
  return host ? { root, name: host } : null;
}

/**
 * The directory that holds this install's code AFTER an upgrade replaced it,
 * or null when nothing has been replaced.
 *
 * One layout produces this and it is a transitional one. Before #340, `npm i -g
 * ccdeck` installed a launcher package with the deck nested inside it:
 *
 *     <prefix>/lib/node_modules/ccdeck/                     the launcher
 *     <prefix>/lib/node_modules/ccdeck/node_modules/agents-deck/   pkgRoot
 *
 * upgradeName reads the host's declared dependency and correctly answers
 * `ccdeck`, so the upgrade runs `npm i -g ccdeck@latest` — which since #340
 * installs the deck itself over the host directory and removes everything that
 * was under it, including pkgRoot. The process keeps running (POSIX keeps an
 * open inode alive, and the modules are already loaded) out of a directory that
 * no longer exists.
 *
 * Deliberately NOT hostPackage. That function recognises a host by the
 * dependency it declares on us, and the whole point here is that the host has
 * just stopped declaring one — it is no longer a launcher, it is the deck. What
 * identifies it instead is its name, confined to the three we publish, for the
 * same reason installedName confines its answer: this decides what a version
 * report says about the user's machine, and a directory that merely happens to
 * sit above us is not evidence.
 *
 * Guarded on our own manifest being unreadable, so nothing changes for an
 * install that is intact — except for the one replacement that leaves a
 * readable manifest behind, which is nestedDeckRoot below.
 */
export function successorRoot(pkgRoot) {
  if (readManifest(pkgRoot)) return nestedDeckRoot(pkgRoot);
  const root = hostRoot(pkgRoot);
  if (!root) return null;
  const name = readManifest(root)?.name;
  return typeof name === "string" && ALIAS_PACKAGES.includes(name) ? root : null;
}

/**
 * The other direction the same replacement can go: the deck moved DOWN, into a
 * node_modules underneath the directory it used to be.
 *
 * `npm i -g agents-deck` before 3.22.3 installed the deck flat — that directory
 * WAS the deck, bin/ and src/ and hook/ and all. What the registry serves for
 * that name now is a 5 KB pointer package: a shim.js, a manifest, and a
 * dependency on `ccdeck`. So reinstalling it replaces the deck with the pointer
 * and puts the real deck one level down, in `<pkgRoot>/node_modules/ccdeck`.
 *
 * The guard above cannot see that, and that is the whole of #975. npm's reify
 * deleted bin/ and src/ but WROTE a package.json in their place, so
 * `readManifest(pkgRoot)` answers — with the shim's manifest — and every reader
 * downstream reads "intact". successorRoot returned null, replacedNote was
 * handed `moved: null` and stayed silent, and the supervisor went on spawning a
 * bin/deck.js npm had just removed: five crash restarts in ten minutes and then
 * a deck that stops for good, with nothing on screen about an upgrade.
 *
 * Three facts together, because none of them alone is evidence. Our name is one
 * of the retired ones; our manifest declares a dependency on the published name,
 * which a deck's own manifest never does; and the package that dependency names
 * is really sitting under us. A deck that merely vendors something, or a
 * retired-name package from before the pointer, matches none of them.
 */
function nestedDeckRoot(pkgRoot) {
  const self = readManifest(pkgRoot);
  if (!RETIRED_NAMES.includes(self?.name)) return null;
  if (typeof self?.dependencies?.[PUBLISHED_NAME] !== "string") return null;
  const root = join(pkgRoot, "node_modules", PUBLISHED_NAME);
  return readManifest(root)?.name === PUBLISHED_NAME ? root : null;
}

/**
 * The retired package this install IS, when reinstalling that package would
 * replace a working deck with the pointer npm now serves for it — or null,
 * which is every other install shape on the planet.
 *
 * `npm i -g agents-deck` and `npm i -g agent-dag` at 3.22.1 or earlier put the
 * deck straight into `<prefix>/lib/node_modules/<name>`: no host above it, no
 * nested copy under it, that directory is the deck. registryName's exception
 * asks npm about `ccdeck` for such an install and is right to — a retired name's
 * dist-tag stopped moving — so the deck correctly learns that a newer version
 * exists. What it then offers is `npm i -g agents-deck@latest`, and since 3.22.8
 * that command fetches 5 KB of shim and deletes the deck to make room for it.
 *
 * The nested layout is the case registryName's comment describes and it is
 * unaffected: there the retired package is the host, the deck is its dependency,
 * and reinstalling the host re-resolves `ccdeck@^3` to the newest deck. The
 * difference is entirely whether the retired name is the wrapper or the thing
 * inside it, and a wrapper is a package — so the directory test below answers
 * that too, before it is asked whose name is on it.
 *
 * Confined to the global layout — `<prefix>/lib/node_modules/<us>` on POSIX,
 * `<prefix>/node_modules/<us>` on Windows — because that is the only tree
 * `npm i -g` rewrites. The test for it is that the directory holding our
 * node_modules is not a package: a global prefix's `lib` has no manifest, while
 * a workspace, a CI job or any tool that vendors the deck as a dependency does.
 * Reinstalling a retired name from inside one of THOSE writes a global tree the
 * project never reads and leaves its copy exactly where it is — a different
 * complaint, and not one to answer by telling somebody to uninstall.
 *
 * A checkout and an npx run are refused before this in every caller, and are
 * refused here too, so the predicate is true on its own terms rather than only
 * in the order it happens to be asked.
 */
export function frozenNameInstall(pkgRoot, name = PUBLISHED_NAME) {
  if (isGitCheckout(pkgRoot) || isNpxInstall(pkgRoot)) return null;
  const above = hostRoot(pkgRoot);
  if (!above || readManifest(above)) return null;
  const self = installedName(pkgRoot, name);
  return RETIRED_NAMES.includes(self) ? self : null;
}

/** The package an upgrade would actually install here — and, but for a retired
 *  name, the one worth asking npm about (see registryName).
 *
 *  The check used to ask about `agents-deck` no matter what the upgrade
 *  command installed, so a deck started with `npx ccdeck` compared its version
 *  against `agents-deck`'s dist-tag and then handed back `npx -y ccdeck@latest`.
 *  Nothing tied the two together. CI publishes the three names one after
 *  another, so between the first and the last publish they genuinely disagree,
 *  and inside that window the deck offered a version the command could not
 *  install — the ETARGET isPublished exists for, with a window measured in
 *  publishes rather than in seconds of propagation.
 *
 *  Deriving the name from what would actually be installed keeps the two halves
 *  consistent by construction: whatever the command will install is what gets
 *  asked about, and the per-name marker follows the same name. Each install
 *  shape carries that answer somewhere different — npx in the spec it recorded,
 *  a stub install in the layout npm built, a plain global install in the
 *  manifest of the package it is. All three are read; none is assumed. */
export function upgradeName(pkgRoot, name = PUBLISHED_NAME) {
  // The published name this build actually carries, which outranks `name` in
  // every branch below because `name` is a default at every call site in the
  // deck and the manifest on disk is not a guess. It replaces the parameter
  // rather than sitting beside it: this one function is where all four of the
  // registry-shaped answers meet — the dist-tag that is fetched, the marker it
  // is cached in, the command the user is shown, and the argv npm is spawned
  // with — so resolving the name once here is what keeps those four naming one
  // package. registryName is the one exception, for a retired name, and it
  // starts from this answer.
  const self = installedName(pkgRoot, name);
  // A checkout installs nothing at all, so the published name is the only
  // sensible subject for the version question — and the only one whose
  // dist-tag says anything about the branch the maintainer is sitting on.
  if (isGitCheckout(pkgRoot)) return self;
  // npx recorded the spec the user typed, which is a better answer than the
  // manifest — except that a retired name answers `ccdeck`. npx reinstalls only
  // when a spec resolves to a different version, and `agents-deck@latest`
  // resolves to the same last-published package forever, so re-running it
  // would reuse the cached copy, and the ccdeck inside it, and never move. The
  // manifest is what is left when the record cannot be read.
  if (isNpxInstall(pkgRoot)) return currentName(bareSpecName(npxRestartSpec(pkgRoot, self)) ?? self);
  // Left: a global install, where the answer is whichever package owns the
  // directory npm would rewrite. That is the stub for `npm i -g ccdeck`, where
  // the deck is nested one level down inside a package it is not named after,
  // and this build's own name for `npm i -g agents-deck` and `npm i -g
  // agent-dag`, where the deck IS the whole package and nothing is above it.
  //
  // successorRoot is the third case, and it is the second half of the same
  // question. Once that stub install HAS been upgraded, the host has stopped
  // declaring a dependency on us — which is the only thing hostPackage
  // recognises a host by — so this fell through to `self`, and `self` is the
  // fallback `agents-deck` because our own manifest went with the directory.
  // The user was then shown `npm i -g agents-deck@latest`: a different package,
  // a second global tree, and their `ccdeck` binary left exactly where it was.
  // That is #358 verbatim, arriving through the upgrade that was supposed to be
  // the end of it. The successor's own manifest names it, and that name is what
  // the next upgrade has to install.
  const host = hostPackage(pkgRoot, self)?.name;
  if (host) return host;
  const moved = successorRoot(pkgRoot);
  return moved ? installedName(moved, self) : self;
}

/** The exact line the user can paste, for the way THIS copy was installed. */
export function upgradeCommand(pkgRoot, name = PUBLISHED_NAME) {
  // A checkout is updated by pulling, and the bundle is built, not shipped —
  // so `npm run build` is part of the answer rather than an afterthought.
  if (isGitCheckout(pkgRoot)) return "git pull && npm run build";
  if (isNpxInstall(pkgRoot)) return `npx -y ${upgradeName(pkgRoot, name)}@latest`;
  // A flat install of a retired name cannot be updated by reinstalling itself —
  // that fetches the pointer package and deletes the deck (frozenNameInstall).
  // The command has to move them onto the published name, and the removal is
  // not optional: the old package owns `<prefix>/bin/ccdeck` as well as its own
  // command, so installing ccdeck alongside it is npm linking a bin over a file
  // another package still claims.
  const frozen = frozenNameInstall(pkgRoot, name);
  if (frozen) return `npm rm -g ${frozen} && npm i -g ${PUBLISHED_NAME}`;
  // Through upgradeName for the same reason the npx line above it is: the
  // printed command is the user's escape hatch when the button fails or is not
  // offered, and one that names a package this install cannot be replaced by is
  // worse than none — it looks like it worked.
  return `npm i -g ${upgradeName(pkgRoot, name)}@latest`;
}

/** The package to ask npm about: the one an upgrade installs, except that a
 *  retired name is asked about as `ccdeck`.
 *
 *  One install reaches that exception. A deck sitting inside the old
 *  `agents-deck` or `agent-dag` package upgrades by reinstalling THAT package —
 *  installing `ccdeck` would write a tree this process never reads, #358 again —
 *  but that package's dist-tag stopped moving when it stopped being published.
 *  The reinstall is still the right act: the old package depends on
 *  `ccdeck@^3`, and npm resolves that to the newest ccdeck on every reinstall,
 *  even of the same version. So the version asked about is ccdeck's and the
 *  command names the old package — the one place the two differ, on purpose. */
export function registryName(pkgRoot, name = PUBLISHED_NAME) {
  return currentName(upgradeName(pkgRoot, name));
}
