// The login item, from the command line: `--install`, `--install-service` and
// `--uninstall-service`.
//
// Lifted out of the one-shot block in bin/deck.js — oneShot in
// bin/cli/one-shot.js now — which still answers all three before the registry
// is read and before anything else in the boot has run. Each resolves to the
// exit code, and deck.js exits with it.
//
// The one-shots' voice comes in with every call — the screen's glyphs and
// palette by the names those lines use, and `say`.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PRODUCT } from "../../src/server/brand.mjs";
import { COMMAND, PKG_ROOT, PKG_VERSION } from "./package.js";
import { G, P, write } from "./screen.js";

// The copy of the deck this file belongs to: what `--install-service` and a
// first start put at login. `--install` names the global copy instead.
const OWN_SCRIPT = join(PKG_ROOT, "bin", "agent-dag.js");

/** The login item's job, for whichever copy of the deck it should start. */
const loginJob = (script, deckLogDir) => ({ script, logPath: join(deckLogDir(), "deck.log"), product: PRODUCT });

/**
 * What the service record says once a login item is written, and once one is
 * taken away. The record is what shouldOfferService reads, so every writer of
 * it goes through these two rather than spelling the shape again.
 */
const installedRecord = (path) => ({ installed: PKG_VERSION, at: new Date().toISOString(), path });
export const removedRecord = () => ({ removed: new Date().toISOString(), version: PKG_VERSION });

/** The one place the three platforms genuinely differ in what a login item buys you. */
function warnWhenLingerOff(svc, { say, tone, gWarn }) {
  if (svc.lingerState() === "off") {
    say(`  ${tone.warn}${gWarn}  systemd tears your session down at logout, so the deck goes with it.${tone.reset}`);
    say(`     ${tone.muted}\`sudo loginctl enable-linger $USER\` keeps it running when you are logged out.${tone.reset}`);
  }
}

// ── --install ─────────────────────────────────────────────────────────────
//
// The one command that turns an npx run into a deck that comes back after a
// reboot. `npx ccdeck` cannot start at login — a login item must name a path
// that will still be there tomorrow, and npx runs out of a cache npm deletes
// whenever it likes — so this puts the package on PATH and points the service
// at THAT.
//
// BEHIND A FLAG, because `npx` means "run without installing" and a tool that
// installs itself anyway is the tool people uninstall. Somebody typed this.
export async function installGlobally({ say, tone, dash, gOk, gWarn, bullet, gEllipsis, deckDataDir, deckLogDir }) {
  const gi = await import(pathToFileURL(join(PKG_ROOT, "src/server/global-install.mjs")).href);
  const svc = await import(pathToFileURL(join(PKG_ROOT, "src/server/login-service.mjs")).href);
  const { installedName } = await import(pathToFileURL(join(PKG_ROOT, "src/server/self-update.mjs")).href);
  const { run } = await import(pathToFileURL(join(PKG_ROOT, "src/server/exec.mjs")).href);
  // The name they typed, not ours. Three packages publish this deck, and
  // installing `ccdeck` for somebody who ran `npx agent-dag` hands them a
  // command they did not ask for.
  const pkg = installedName(PKG_ROOT, PRODUCT);

  say(`\n  ${tone.muted}${dash}  installing ${pkg} globally${gEllipsis}${tone.reset}`);
  const got = await run("npm", ["i", "-g", pkg], { timeout: gi.INSTALL_TIMEOUT_MS });
  if (!got?.ok) {
    say(`  ${tone.err}${gWarn}  ${gi.installFailure(got, { pkg })}${tone.reset}\n`);
    return 1;
  }
  say(`  ${tone.ok}${gOk}${tone.reset}  ${pkg} is on your PATH${tone.muted}  ${bullet}  type \`${pkg}\` to start it${tone.reset}`);

  // WHERE npm PUT IT, asked rather than assumed: a prefix the user set
  // themselves is common and nothing here can guess it.
  const root = gi.readGlobalRoot(await run("npm", ["root", "-g"], { timeout: 30_000 }));
  const script = gi.globalScript(root, pkg);
  if (!script) {
    say(`  ${tone.warn}${gWarn}  installed, but npm did not say where ${dash} run \`${pkg} --install-service\` to start it at login${tone.reset}\n`);
    return 0;
  }
  const out = svc.installService(loginJob(script, deckLogDir));
  if (!out.ok) {
    say(`  ${tone.warn}${gWarn}  installed, but it will not start at login ${dash} ${out.reason}${tone.reset}\n`);
    return 0;
  }
  svc.writeServiceRecord(deckDataDir(), installedRecord(out.path));
  say(`  ${tone.ok}${gOk}${tone.reset}  and starts when you log in${tone.muted}  ${bullet}  ${out.path}${tone.reset}`);
  warnWhenLingerOff(svc, { say, tone, gWarn });
  say(`     ${tone.muted}\`${pkg} --uninstall-service\` undoes the login part${tone.reset}\n`);
  return 0;
}

// ── --install-service / --uninstall-service ───────────────────────────────
// Answered before the registry is read: neither one is about a deck that is
// running, and both are as meaningful on a machine with no deck up as on one
// with three.
export async function loginItemCommand(flags, { say, tone, dash, gOk, gWarn, bullet, deckDataDir, deckLogDir }) {
  const svc = await import(pathToFileURL(join(PKG_ROOT, "src/server/login-service.mjs")).href);
  const { isGitCheckout, isNpxInstall } = await import(pathToFileURL(join(PKG_ROOT, "src/server/self-update.mjs")).href);
  if (flags.uninstallService) {
    const out = svc.uninstallService();
    // Recorded either way. The record is what stops the next ordinary start
    // putting back what was just taken away, and a tool that argues with its
    // user about a login item is a tool that gets uninstalled entirely.
    svc.writeServiceRecord(deckDataDir(), removedRecord());
    // `existed` rather than the record: the record says what THIS tool last
    // did, and the machine is what actually has a login item on it. Somebody
    // who removed the plist by hand should be told the truth about the
    // machine, not about our bookkeeping.
    say(!out.ok
      ? `\n  ${tone.err}${gWarn}  could not remove it ${dash} ${out.reason}${tone.reset}\n`
      : out.existed
        ? `\n  ${tone.ok}${gOk}${tone.reset}  no longer starts at login${tone.muted}  ${bullet}  ${out.path}${tone.reset}\n`
        : `\n  ${tone.muted}${dash}  it was not starting at login${tone.reset}\n`);
    return out.ok ? 0 : 1;
  }
  if (isGitCheckout(PKG_ROOT)) {
    // Not refused outright — somebody running from a checkout may genuinely
    // want this — but not done silently either: the item would name a working
    // tree, and that is worth knowing before it is written.
    say(`\n  ${tone.warn}${gWarn}  this is a checkout, so the login item would name ${PKG_ROOT}${tone.reset}`);
    say(`     ${tone.muted}a renamed, moved or deleted working tree leaves a login item pointing at nothing${tone.reset}\n`);
  }
  if (isNpxInstall(PKG_ROOT)) {
    // The item would name a path inside ~/.npm/_npx/<hash>/, which npm deletes
    // whenever it feels like it — a login item pointing at nothing, forever,
    // on a machine where nothing was ever installed.
    say(`\n  ${tone.warn}${gWarn}  an npx run cannot start at login ${dash} its files live in npm's cache and are deleted without warning.${tone.reset}`);
    say(`     ${tone.muted}install it first: \`npm i -g ${COMMAND}\`${tone.reset}\n`);
    return 1;
  }
  const out = svc.installService(loginJob(OWN_SCRIPT, deckLogDir));
  if (!out.ok) {
    say(`\n  ${tone.err}${gWarn}  could not set it up ${dash} ${out.reason}${tone.reset}\n`);
    return 1;
  }
  svc.writeServiceRecord(deckDataDir(), installedRecord(out.path));
  say(`\n  ${tone.ok}${gOk}${tone.reset}  starts when you log in${tone.muted}  ${bullet}  ${out.path}${tone.reset}`);
  if (out.how === "file-only") {
    // The file is on disk and both launchd and systemd read their directories
    // at the next login, so this works from then on. Said rather than hidden:
    // "it will work tomorrow" is a different promise from "it works now".
    say(`  ${tone.warn}${gWarn}  not started now ${dash} ${out.reason}. It will come up at your next login.${tone.reset}`);
  }
  warnWhenLingerOff(svc, { say, tone, gWarn });
  say(`     ${tone.muted}\`${COMMAND} --uninstall-service\` undoes it${tone.reset}\n`);
  return 0;
}

// ── starting at login ─────────────────────────────────────────────────────────
//
// ONCE PER MACHINE, EVER. The record in the deck's own data directory is what
// makes that true: without it, `--uninstall-service` would be undone by the next
// start, which is not an uninstall — it is a tool arguing with its user.
//
// npx is excluded and AGENTS_DECK_NO_INSTALL is honoured — see
// shouldOfferService, which owns both rules and says why. A failure is one line
// and nothing else: the deck is already running, and the worst case is the
// behaviour every version before this one had.
//
// Called by the boot, not by a one-shot, so it writes the boot's way: `P`, `G`
// and `write`, straight from bin/cli/screen.js.
export async function offerLoginItem({ deckDataDir, deckLogDir }) {
  try {
    const svc = await import(pathToFileURL(join(PKG_ROOT, "src/server/login-service.mjs")).href);
    const { isGitCheckout, isNpxInstall } = await import(pathToFileURL(join(PKG_ROOT, "src/server/self-update.mjs")).href);
    if (svc.shouldOfferService({
      record: svc.readServiceRecord(deckDataDir()),
      npx: isNpxInstall(PKG_ROOT),
      checkout: isGitCheckout(PKG_ROOT),
    })) {
      const out = svc.installService(loginJob(OWN_SCRIPT, deckLogDir));
      svc.writeServiceRecord(deckDataDir(), out.ok
        ? installedRecord(out.path)
        : { failed: out.reason ?? "unknown", at: new Date().toISOString(), version: PKG_VERSION });
      // Said once, on the one run that does it, and never again. A tool that
      // adds itself to your login items and does not mention it is a tool you
      // find later, in a settings pane, and stop trusting.
      write(out.ok
        ? `  ${P.muted}${G.dash}  ${PRODUCT} will now start when you log in ${G.dash} \`${COMMAND} --uninstall-service\` undoes it${P.reset}\n\n`
        : `  ${P.muted}${G.dash}  could not set ${PRODUCT} to start at login (${out.reason}) ${G.dash} it still starts when you type it${P.reset}\n\n`);
    }
  } catch (err) {
    // Never fatal. The deck is up; this is a convenience that did not happen.
    console.error(`${PRODUCT}: could not check the login item:`, err?.message ?? err);
  }
}
