// `--uninstall`, and `--purge` with it: every trace of the deck that is not
// somebody's data, taken off the machine, and every one that could not be,
// named.
//
// Lifted out of bin/deck.js, which still answers it before the migration and
// well before the heavy imports, exactly where the block used to sit. Every
// module the uninstall touches is still imported off PKG_ROOT at the moment it
// is needed, so `--uninstall` loads only what it uses and starts nothing.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PRODUCT } from "../../src/server/brand.mjs";
import { glyphs, unicodeOK } from "../../src/server/term.mjs";
import { INVOKED_AS, PKG_ROOT, PKG_VERSION } from "./package.js";

/**
 * Remove this deck's hooks, its login item and, with `flags.purge`, the files
 * holding its LAN private key — and say what happened to each.
 *
 * Resolves to the exit code rather than exiting, so the caller owns the
 * process: 1 when any half of it refused, 0 otherwise.
 */
export async function uninstall(flags) {
  const { uninstallHooks, hasCodexInstalled } = await import(pathToFileURL(join(PKG_ROOT, "src/server/installer.mjs")).href);
  // Anything that could not be taken out. An uninstall that removed nothing
  // because it could not read the file has not uninstalled anything, and both
  // the wording and the exit code have to say so: a user who is told it worked
  // and still has our hooks firing on every event is worse off than one who is
  // told it failed, because they have stopped looking.
  let refused = false;
  // Files already reported as unparseable. The Claude hooks and the sound hook
  // live in the SAME settings.json, so a stray comma refuses both, and printing
  // the whole path-plus-parser-error twice buries the one line that differs —
  // which of our two installations is still in there.
  const named = new Set();
  // Its own glyphs for the same reason the bad-port line in deck.js has them:
  // this runs well before deck.js declares `G` (#797).
  const { dash: gDash } = glyphs(unicodeOK());
  /** Report one provider's outcome. `ok` first — see uninstallHooks. */
  const report = (res, label) => {
    if (res.ok === false) {
      refused = true;
      named.add(res.settingsPath);
      console.error(`${PRODUCT}: ${label} hooks NOT removed ${gDash} ${res.settingsPath} could not be read as JSON (${res.why}).`);
      console.error(`${PRODUCT}: the __agent-dag hook entries are still in that file and keep firing on every ${label} event.`);
      return;
    }
    console.log(res.changed
      ? `${PRODUCT}: hooks removed from ${res.settingsPath}`
      : `${PRODUCT}: no ${label} hooks to remove`);
  };
  report(await uninstallHooks({ provider: "claude" }), "Claude");
  // The old finish sound was a second entry in the same file, marked
  // __agent-dag-sound rather than __agent-dag, and uninstallHooks does not know
  // that mark — so it used to be left behind, playing on every turn after the
  // deck was supposedly gone. #704 retired the mechanism outright, but the entry
  // is still on every machine that had it, so removing it is still this
  // command's job. So is the other half: turning the sound on parked the user's
  // own afplay/PowerShell Stop hooks, and once the deck is uninstalled nothing
  // else on the machine knows where they went.
  // The login item goes too, and this is the one place the uninstall's
  // documented narrowness has to bend. "Hook entries only" is right for the
  // event log and the port registry, which are data somebody may still want —
  // but a login item left behind after an uninstall is not data, it is a
  // machine that keeps starting a deck whose hooks were just removed.
  {
    const svc = await import(pathToFileURL(join(PKG_ROOT, "src/server/login-service.mjs")).href);
    const { deckDataDir: dataDir } = await import(pathToFileURL(join(PKG_ROOT, "src/server/deck-home.mjs")).href);
    if (svc.readServiceRecord(dataDir()) !== null) {
      const gone = svc.uninstallService();
      svc.writeServiceRecord(dataDir(), { removed: new Date().toISOString(), version: PKG_VERSION });
      // Silent when there was nothing on the machine: an uninstall that reports
      // removing a login item this deck never had is the same lie the explicit
      // command used to tell, in the place a reader is least able to check it.
      if (!gone.ok) {
        // `gDash`, not an em dash: this runs before the boot, on a console that
        // may be the legacy Windows one, and #797 is the rule that a printed
        // string never carries punctuation the terminal may not have.
        console.error(`${PRODUCT}: could NOT remove the login item ${gDash} ${gone.reason} (${gone.path})`);
      } else if (gone.existed) {
        console.log(`${PRODUCT}: no longer starts at login`);
      }
      if (!gone.ok) refused = true;
    }
  }

  const { retireSoundHook } = await import(pathToFileURL(join(PKG_ROOT, "src/server/retire-sound-hook.mjs")).href);
  const sound = await retireSoundHook();
  if (sound.removed) console.log(`${PRODUCT}: sound hook removed`);
  if (sound.restored) console.log(`${PRODUCT}: restored ${sound.restored} of your own sound hook(s)`);
  if (sound.ok === false) {
    refused = true;
    // Two different refusals, and saying the wrong one sends the user to the
    // wrong file. `settings_unreadable` means nothing was touched at all — and
    // when the forwarders already named that same file, the whole path and
    // parser error would only bury the one line that differs. `parked_unreadable`
    // is the other file: our entry IS out (the lines above said so), and what is
    // still owed is the user's own hooks, which stay parked until they repair it.
    if (sound.reason === "settings_unreadable") {
      console.error(named.has(sound.settingsPath)
        ? `${PRODUCT}: the sound hook is still in that file too.`
        // `gDash`, like every other line here (#797, #1431).
        : `${PRODUCT}: sound hook left in place ${gDash} ${sound.message}`);
      named.add(sound.settingsPath);
    } else {
      console.error(`${PRODUCT}: your own sound hooks were NOT restored ${gDash} ${sound.message}`);
    }
  }
  if (hasCodexInstalled()) {
    report(await uninstallHooks({ provider: "codex" }), "Codex");
  }
  // ── THE PRIVATE KEY ────────────────────────────────────────────────────────
  //
  // The one thing left on the disk that is a CREDENTIAL rather than data. Every
  // deck paired with this one has pinned the key in prefs.json, and until #959
  // nothing in this command — or in the `--help` text, or in the README's
  // uninstall paragraph — named the file, so somebody who followed the
  // instructions to the letter believed the machine was clean and it was not.
  //
  // NAMED, NOT REMOVED, unless somebody asked. prefs.json also holds the
  // pairings, the aliases and which accounts this deck offers, and deleting a
  // user's settings out from under a command documented as "hook entries only"
  // is a different complaint of the same size. So the default is to say exactly
  // where the key is — resolved for THIS machine, both copies, because
  // `migrateDeckFiles` copies rather than moves and the old one is in a
  // directory nothing calls the deck's state — and `--purge` is the sentence
  // somebody types when they mean it.
  {
    const { keyDirs, findKeyFiles, purgeKeyFiles } =
      await import(pathToFileURL(join(PKG_ROOT, "src/server/purge-key.mjs")).href);
    const found = await findKeyFiles(keyDirs());
    if (flags.purge) {
      const { removed, failed } = await purgeKeyFiles(found);
      for (const path of removed) console.log(`${PRODUCT}: removed ${path}`);
      for (const f of failed) {
        refused = true;
        // `gDash`, not an em dash: before the boot, possibly the legacy Windows
        // console (#797).
        console.error(`${PRODUCT}: could NOT remove ${f.path} ${gDash} ${f.why}`);
        console.error(`${PRODUCT}: this deck's LAN private key is still in that file.`);
      }
      if (removed.length === 0 && failed.length === 0) {
        console.log(`${PRODUCT}: no ${PRODUCT} state to purge`);
      }
    } else {
      // "no-key" files are not mentioned. Telling somebody their private key is
      // on the machine when the file has none is the same defect as the silence,
      // pointing the other way. "unknown" IS mentioned: an unparseable file is
      // the one nobody can rule a key out of.
      const holding = found.filter(f => f.holds !== "no-key");
      if (holding.length > 0) {
        console.log(`${PRODUCT}: this deck's LAN private key is still on this machine:`);
        for (const f of holding) {
          console.log(`${PRODUCT}:   ${f.path}${f.holds === "unknown" ? `  (unreadable ${gDash} ${f.why})` : ""}`);
        }
        console.log(`${PRODUCT}: every deck you paired with has pinned that key. \`${INVOKED_AS ?? PRODUCT} --uninstall --purge\` removes the file(s) above.`);
      }
    }
  }

  // The remedy last and once, after every symptom above it, rather than once
  // per refusal in the middle of the list.
  if (named.size > 0) {
    console.error(`${PRODUCT}: repair the JSON (or move the file aside), then run \`${PRODUCT} --uninstall\` again.`);
  }
  // Non-zero when any half of it refused, so `ccdeck --uninstall && …` and every
  // CI step that runs this stops on the failure instead of continuing past it.
  return refused ? 1 : 0;
}
